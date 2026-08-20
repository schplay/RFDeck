import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Returns the MAC address for a given IP by querying the OS ARP cache.
// The ARP entry is populated automatically when we've communicated with the
// device (UDP or TCP contact is enough), so this is reliable immediately
// after a successful connect.  Returns null on any error or cache miss.
export async function getMacByIp(ip: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      process.platform === 'win32' ? `arp -a ${ip}` : `arp -n ${ip}`,
      { timeout: 3000 },
    );

    // Windows:  "  10.2.1.154    a4-c3-f0-dd-72-38    dynamic"
    // Linux:    "10.2.1.154 ether a4:c3:f0:dd:72:38 C eth0"
    // macOS:    "10.2.1.154 (10.2.1.154) at a4:c3:f0:dd:72:38 on en0"
    const match = stdout.match(
      /([0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2})/i,
    );
    if (!match) return null;

    // Normalise to lower-case colon notation
    return match[1].toLowerCase().replace(/-/g, ':');
  } catch {
    return null;
  }
}
