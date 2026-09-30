import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Returns the MAC address for a given IP by querying the OS neighbour table.
// The entry is populated automatically once we've communicated with the device
// (UDP or TCP contact is enough), so this is reliable immediately after a
// successful connect. Returns null on any error or cache miss.
//
// On Linux the primary tool is `ip neigh` from iproute2, which every modern
// distribution ships. `arp` comes from net-tools, which Ubuntu no longer
// installs by default — relying on it meant every lookup on a headless server
// failed silently: G3/G4 MACs were never recorded, and MAC-based reconnection
// after an IP change could never match anything.

export function macFromLookupOutput(stdout: string): string | null {
  // Windows arp:  "  10.2.1.154    a4-c3-f0-dd-72-38    dynamic"
  // Linux ip:     "10.2.1.154 dev eno1 lladdr a4:c3:f0:dd:72:38 REACHABLE"
  // Linux arp:    "10.2.1.154 ether a4:c3:f0:dd:72:38 C eth0"
  // macOS arp:    "10.2.1.154 (10.2.1.154) at a4:c3:f0:dd:72:38 on en0"
  // A FAILED/incomplete entry prints no address at all, so no match means miss.
  const match = stdout.match(
    /([0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2})/i,
  );
  if (!match) return null;
  return match[1].toLowerCase().replace(/-/g, ':');
}

async function tryCommand(command: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(command, { timeout: 3000 });
    return macFromLookupOutput(stdout);
  } catch {
    return null;
  }
}

export async function getMacByIp(ip: string): Promise<string | null> {
  if (process.platform === 'win32') {
    return tryCommand(`arp -a ${ip}`);
  }
  // iproute2 first; net-tools arp as a fallback for systems that have it.
  return (await tryCommand(`ip neigh show ${ip}`)) ?? tryCommand(`arp -n ${ip}`);
}

/**
 * Is this address on a subnet this host is directly attached to?
 *
 * The distinction matters because it separates two outcomes that look identical
 * and are not alike: a neighbour entry that is missing *for now*, and one that can
 * never exist. The table is populated when this host resolves an address in order
 * to send to it, and it only ever resolves addresses on its own links — for
 * anything beyond a router the kernel resolves the next hop instead. So for an
 * off-link device there is no entry, no retry will produce one, and no hardware
 * address for it is obtainable from this machine at all.
 *
 * Reported rather than inferred, because RFDeck spent a rig session telling an
 * operator that eleven receivers could not be matched and should be corrected by
 * hand, when the real statement was "not yet" — and the two need different words.
 */
export function isDirectlyAttached(
  ip: string,
  interfaces: Array<{ address: string; netmask: string }>,
): boolean {
  const toInt = (addr: string): number | null => {
    const parts = addr.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    // >>> 0 so the result is unsigned: a mask of 255.255.255.0 is negative as a
    // signed 32-bit int, and comparing the two would then never agree.
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  };

  const target = toInt(ip);
  if (target === null) return false;

  return interfaces.some(iface => {
    const addr = toInt(iface.address);
    const mask = toInt(iface.netmask);
    if (addr === null || mask === null) return false;
    return ((target & mask) >>> 0) === ((addr & mask) >>> 0);
  });
}
