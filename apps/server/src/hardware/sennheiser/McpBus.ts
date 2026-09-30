import dgram from 'dgram';
import os from 'os';
import { log } from '../../logger';

// Singleton UDP socket on port 53212 shared by DiscoveryService and all G3G4Client instances.
// Having one socket avoids the EADDRINUSE / Windows-Firewall issue that arises when two
// callers independently try to bind the same well-known port.

const MCP_PORT = 53212;

type MsgHandler = (raw: string, fromIp: string) => void;

export class McpBus {
  private sock: dgram.Socket | null = null;
  private ipHandlers  = new Map<string, Set<MsgHandler>>();
  private anyHandlers = new Set<MsgHandler>();
  private ready       = false;
  private sendQueue: Array<{ ip: string; buf: Buffer }> = [];
  // Our own IPv4 addresses. Broadcast probes we send loop back to our own socket
  // (bound to 0.0.0.0 with SO_BROADCAST); without this filter the discovery
  // listener would see our own "Name\r" probe and report this machine as a device.
  private localIps = new Set<string>();
  private localIpsRefreshedAt = 0;
  private static readonly LOCAL_IPS_TTL_MS = 30_000;

  private isOwnAddress(ip: string): boolean {
    const now = Date.now();
    if (now - this.localIpsRefreshedAt > McpBus.LOCAL_IPS_TTL_MS) {
      this.localIps.clear();
      this.localIps.add('127.0.0.1');
      for (const addrs of Object.values(os.networkInterfaces())) {
        for (const addr of addrs ?? []) {
          if (addr.family === 'IPv4') this.localIps.add(addr.address);
        }
      }
      this.localIpsRefreshedAt = now;
    }
    return this.localIps.has(ip);
  }

  async init(): Promise<void> {
    if (this.sock) return;
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock = sock;

      sock.once('error', (err) => {
        if (!this.ready) reject(err);
        else log.error('[McpBus] socket error:', err.message);
      });

      sock.on('message', (msg, rinfo) => {
        const ip = rinfo.address;
        if (this.isOwnAddress(ip)) return; // our own broadcast probe looping back
        const raw = msg.toString('ascii');
        this.ipHandlers.get(ip)?.forEach(h => h(raw, ip));
        this.anyHandlers.forEach(h => h(raw, ip));
      });

      sock.bind(MCP_PORT, () => {
        sock.setBroadcast(true);

        // Buffers sized for a sweep happening at the same time as live telemetry.
        //
        // One socket carries both: the status stream from every tracked receiver,
        // arriving continuously, and the discovery sweep, which on a flat /16
        // sends 131,000 datagrams and invites replies from anything that hears
        // them. At the OS default of a couple of hundred kilobytes the receive
        // queue overflows while a sweep runs, and what is dropped is the
        // telemetry — so receivers that were online and perfectly healthy fall
        // silent, hit their fifteen-second timeout and are reported offline. The
        // symptom is devices dropping *because* other devices were found, which
        // reads as anything but a buffer size.
        //
        // The kernel clamps these to net.core.rmem_max / wmem_max, so the request
        // is deliberately generous and the result is logged rather than assumed.
        try {
          sock.setRecvBufferSize(8 * 1024 * 1024);
          sock.setSendBufferSize(4 * 1024 * 1024);
        } catch (err: any) {
          log.warn(`[McpBus] Could not resize socket buffers: ${err?.message}`);
        }
        try {
          log.info(
            `[McpBus] UDP buffers: receive ${Math.round(sock.getRecvBufferSize() / 1024)} KiB, ` +
            `send ${Math.round(sock.getSendBufferSize() / 1024)} KiB`,
          );
        } catch { /* not every platform reports these */ }
        this.ready = true;
        log.debug(`[McpBus] Shared UDP socket bound to :${MCP_PORT}`);
        for (const { ip, buf } of this.sendQueue) {
          sock.send(buf, 0, buf.length, MCP_PORT, ip);
        }
        this.sendQueue = [];
        resolve();
      });
    });
  }

  /**
   * A hard ceiling on outbound datagrams, independent of whoever is sending them.
   *
   * Every fix above this line addresses a *reason* the bus was over-used, and each
   * was correct when written. A sweep sized to the netmask rather than to the rig
   * still put 25,600 packets a second onto a venue's network, in bursts, for as long
   * as any device was switched off — and the only thing that stopped it was killing
   * the process. The lesson is not that the sweep needed different constants; it is
   * that nothing downstream of this method was ever bounded, so any mistake in
   * target selection became a network outage.
   *
   * So the bound lives here, where all MCP traffic passes, and it holds whatever
   * future code does. It sits far above what correct operation needs: a rig of a few
   * dozen receivers renewing subscriptions every eight seconds is single digits per
   * second, and a bounded sweep is about 1,300. Nothing legitimate comes close, so
   * anything that trips this is a bug, and it says so.
   */
  private static readonly MAX_SENDS_PER_SEC = 4_000;
  private sendWindowStart = 0;
  private sendsThisWindow = 0;
  private droppedThisWindow = 0;

  /** True if this datagram is within the ceiling. Counts, and reports overruns. */
  private withinSendBudget(): boolean {
    const now = Date.now();
    if (now - this.sendWindowStart >= 1000) {
      if (this.droppedThisWindow > 0) {
        // `error`, not `warn`: reaching this means RFDeck tried to put more than
        // 4,000 datagrams a second onto somebody's network. That is never correct.
        log.error(
          `[McpBus] Outbound MCP ceiling hit — sent ${this.sendsThisWindow}, ` +
          `DROPPED ${this.droppedThisWindow} datagram(s) in the last second. This is a ` +
          `bug in whatever is sending: no correct operation approaches this rate.`,
        );
      }
      this.sendWindowStart = now;
      this.sendsThisWindow = 0;
      this.droppedThisWindow = 0;
    }
    if (this.sendsThisWindow >= McpBus.MAX_SENDS_PER_SEC) {
      this.droppedThisWindow++;
      return false;
    }
    this.sendsThisWindow++;
    return true;
  }

  sendTo(ip: string, command: string): void {
    if (!this.withinSendBudget()) return;
    const buf = Buffer.from(command.endsWith('\r') ? command : command + '\r', 'ascii');
    if (this.ready && this.sock) {
      this.sock.send(buf, 0, buf.length, MCP_PORT, ip, (err) => {
        if (err) log.warn(`[McpBus] send → ${ip}: ${err.message}`);
      });
    } else {
      this.sendQueue.push({ ip, buf });
    }
  }

  sendToMany(ips: string[], command: string): void {
    for (const ip of ips) this.sendTo(ip, command);
  }

  // Register a handler for packets from a specific IP only.
  addHandler(ip: string, handler: MsgHandler): void {
    let set = this.ipHandlers.get(ip);
    if (!set) { set = new Set(); this.ipHandlers.set(ip, set); }
    set.add(handler);
  }

  removeHandler(ip: string, handler: MsgHandler): void {
    this.ipHandlers.get(ip)?.delete(handler);
  }

  // Register a handler for ALL incoming packets (used by discovery).
  addAnyHandler(handler: MsgHandler): void   { this.anyHandlers.add(handler); }
  removeAnyHandler(handler: MsgHandler): void { this.anyHandlers.delete(handler); }

  /**
   * The interface the operator chose in Settings, or 0.0.0.0 for all of them.
   *
   * Settings has offered this choice, described as "used for mDNS discovery and
   * hardware communication", since before any of the discovery code was
   * written — and nothing ever read it. The value was stored, redisplayed, and
   * ignored. Every interface was used regardless.
   *
   * That is not a cosmetic gap on a real rig. A venue server is routinely on
   * two networks, control and Dante, and an EW-DX answers on both with the same
   * serial number. Discovery running across both sees one receiver twice and
   * then has to guess which address is the control interface — a guess that,
   * when it goes wrong, withholds the address that actually works. Honouring
   * the choice removes the ambiguity instead of arbitrating it.
   */
  private bindAddress = '0.0.0.0';

  setBindAddress(address: string | null | undefined): void {
    const next = (address ?? '').trim() || '0.0.0.0';
    if (next === this.bindAddress) return;
    this.bindAddress = next;
    log.info(`[McpBus] Network interface set to ${next === '0.0.0.0' ? 'all interfaces' : next}`);
  }

  getBindAddress(): string { return this.bindAddress; }

  private usable(addr: os.NetworkInterfaceInfo): boolean {
    return addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.');
  }

  private allInterfaces(): Array<{ address: string; netmask: string }> {
    const result: Array<{ address: string; netmask: string }> = [];
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (this.usable(addr)) result.push({ address: addr.address, netmask: addr.netmask });
      }
    }
    return result;
  }

  getBroadcastAddresses(): string[] {
    const list: string[] = ['255.255.255.255'];
    for (const iface of this.getActiveInterfaces()) {
      const b = this.computeBroadcast(iface.address, iface.netmask);
      if (b) list.push(b);
    }
    return [...new Set(list)];
  }

  getActiveInterfaces(): Array<{ address: string; netmask: string }> {
    const all = this.allInterfaces();
    if (this.bindAddress === '0.0.0.0') return all;

    const chosen = all.filter(i => i.address === this.bindAddress);
    if (chosen.length > 0) return chosen;

    // The chosen address is not on this machine any more — a NIC replaced, a
    // DHCP lease changed, a config copied between servers. Falling back to
    // every interface keeps RFDeck able to find hardware, which matters more
    // than honouring a setting that no longer describes anything; going deaf
    // instead would be the worse failure. Said loudly, because the setting on
    // screen no longer matches what is happening.
    log.warn(
      `[McpBus] The selected network interface ${this.bindAddress} is not present ` +
      `on this machine (available: ${all.map(i => i.address).join(', ') || 'none'}). ` +
      `Using all interfaces. Update it in Settings -> Network.`,
    );
    return all;
  }

  private computeBroadcast(ip: string, mask: string): string | null {
    const a = ip.split('.').map(Number);
    const m = mask.split('.').map(Number);
    if (a.length !== 4 || m.length !== 4) return null;
    return a.map((b, i) => b | (~m[i] & 0xff)).join('.');
  }

  close() {
    if (this.sock) { try { this.sock.close(); } catch { /* ignore */ } this.sock = null; }
    this.ready = false;
  }
}

export const mcpBus = new McpBus();
