import dgram from 'dgram';
import { EventEmitter } from 'events';
import { log } from '../../logger';

// Shure device discovery: SLP announcements on a multicast group.
//
// Not mDNS. Shure's own "device IP ports and protocols" document lists UDP
// 8427 as "Shure SLP (discovery) (multicast)", and micboard's py/discover.py
// joins 239.255.254.253 on that port and listens. Receivers announce
// themselves periodically, so this is passive — nothing is broadcast at the
// network to make it work.
//
// This is the same shape as the Sennheiser G3/G4 path RFDeck already has: a
// passive listener produces candidate addresses, and a probe on the control
// port confirms what they actually are. The announcement is not treated as
// identification on its own.

export const SHURE_SLP_GROUP = '239.255.254.253';
export const SHURE_SLP_PORT = 8427;

/**
 * The device class id from an announcement, if there is one.
 *
 * The payload is comma-separated parenthesised fields; `cd:` carries a DCID
 * that maps to a model through DCIDMap.xml — a proprietary file shipping with
 * Wireless Workbench. RFDeck does not have that map and does not need it: the
 * useful part of an announcement is which address it came from, and the model
 * is then asked for directly over 2202.
 *
 * The DCID is still worth extracting, because it is the cheapest evidence that
 * a packet is a Shure announcement rather than something else that happens to
 * be using this group.
 */
export function parseSlpAnnouncement(payload: string): { dcid: string | null } {
  for (const field of payload.split(',')) {
    const cleaned = field.replace(/[()]/g, '').trim();
    const at = cleaned.indexOf('cd:');
    if (at !== -1) {
      const dcid = cleaned.slice(at + 3).trim();
      if (dcid) return { dcid };
    }
  }
  return { dcid: null };
}

/**
 * Does this look like a Shure announcement at all?
 *
 * Deliberately loose. The multicast group is Shure's, so anything arriving on
 * it is already a strong hint, and the probe that follows is what actually
 * decides. Being strict here would mean silently dropping models whose
 * announcement format differs from the one example available.
 */
export function looksLikeAnnouncement(payload: string): boolean {
  if (!payload || payload.length > 4096) return false;
  return /cd:/.test(payload) || /shure/i.test(payload);
}

export interface SlpAnnouncement {
  ip: string;
  dcid: string | null;
}

export class ShureSlpListener extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private joined: string[] = [];

  /**
   * @param interfaces Local IPv4 addresses to join the group on. A machine at
   *   a venue routinely has more than one — a control network and a Dante
   *   network — and joining only the default route misses everything on the
   *   other.
   */
  start(interfaces: string[]): void {
    if (this.socket) return;

    // reuseAddr so several listeners on this host can share the port, and so a
    // restart does not have to wait out TIME_WAIT mid-show.
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err: NodeJS.ErrnoException) => {
      // Not fatal. Discovery is a convenience — devices can always be added by
      // IP — so a port that will not bind must not take the server with it.
      if (err.code === 'EADDRINUSE') {
        log.warn(
          `[Discovery] UDP ${SHURE_SLP_PORT} is in use, so Shure announcements ` +
          `cannot be heard. Another Shure tool is probably running on this ` +
          `machine. Receivers can still be added by IP.`,
        );
      } else {
        log.warn(`[Discovery] Shure SLP listener error: ${err.message}`);
      }
      this.stop();
    });

    socket.on('message', (buf, rinfo) => {
      const payload = buf.toString('utf8');
      if (!looksLikeAnnouncement(payload)) return;
      const { dcid } = parseSlpAnnouncement(payload);
      this.emit('announce', { ip: rinfo.address, dcid } as SlpAnnouncement);
    });

    socket.on('listening', () => {
      try {
        socket.setBroadcast(true);
      } catch { /* not required, and not available everywhere */ }

      for (const iface of interfaces) {
        try {
          socket.addMembership(SHURE_SLP_GROUP, iface);
          this.joined.push(iface);
        } catch (err: any) {
          // One interface refusing membership is normal — a virtual adapter, a
          // disconnected NIC — and must not stop the others.
          log.debug(`[Discovery] Could not join ${SHURE_SLP_GROUP} on ${iface}: ${err?.message}`);
        }
      }

      if (this.joined.length === 0) {
        // Still listening: a group joined by another process on this host can
        // deliver packets here anyway, so this is a warning rather than a stop.
        log.warn(`[Discovery] No interface accepted the Shure discovery group`);
      } else {
        log.debug(`[Discovery] Listening for Shure announcements on ${this.joined.join(', ')}`);
      }
    });

    try {
      socket.bind(SHURE_SLP_PORT);
    } catch (err: any) {
      log.warn(`[Discovery] Could not bind UDP ${SHURE_SLP_PORT}: ${err?.message}`);
      this.stop();
    }
  }

  stop(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;

    for (const iface of this.joined) {
      try { socket.dropMembership(SHURE_SLP_GROUP, iface); } catch { /* already gone */ }
    }
    this.joined = [];

    socket.removeAllListeners();
    socket.on('error', () => { /* closing */ });
    try { socket.close(); } catch { /* already closed */ }
  }
}
