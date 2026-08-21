import dgram from 'dgram';
import os from 'os';
import { log } from '../../logger';

// Singleton UDP socket on port 53212 shared by DiscoveryService and all G3G4Client instances.
// Having one socket avoids the EADDRINUSE / Windows-Firewall issue that arises when two
// callers independently try to bind the same well-known port.

const MCP_PORT = 53212;

type MsgHandler = (raw: string, fromIp: string) => void;

class McpBus {
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

  sendTo(ip: string, command: string): void {
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

  getBroadcastAddresses(): string[] {
    const list: string[] = ['255.255.255.255'];
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
          const b = this.computeBroadcast(addr.address, addr.netmask);
          if (b) list.push(b);
        }
      }
    }
    return [...new Set(list)];
  }

  getActiveInterfaces(): Array<{ address: string; netmask: string }> {
    const result: Array<{ address: string; netmask: string }> = [];
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) {
          result.push({ address: addr.address, netmask: addr.netmask });
        }
      }
    }
    return result;
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
