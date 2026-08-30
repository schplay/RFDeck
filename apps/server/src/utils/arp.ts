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
