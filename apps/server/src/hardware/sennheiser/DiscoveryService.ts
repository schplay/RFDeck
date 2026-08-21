import Bonjour from 'bonjour-service';
import os from 'os';
import https from 'https';
import axios from 'axios';
import { EventEmitter } from 'events';
import { mcpBus } from './McpBus';
import { log } from '../../logger';

export interface DiscoveredDevice {
  ip: string;
  port: number;
  name: string;
  protocol: 'ssc' | 'sennheiser-ssc' | 'mcp' | string;
}

const MCP_PORT = 53212;
const SSC_PORT  = 443;

// A valid MCP response line starts with one of these tokens
const MCP_RESPONSE_RE = /^(States|AF|RF1|RF2|RF|Bat|Frequency|Name|Msg)\s/m;

// Shared HTTPS client for probing EW-DX devices (self-signed certs, legacy TLS).
// 2500ms gives embedded firmware enough time to complete the TLS handshake.
// Batch size (12) × timeout (2.5s) ≈ 2.5s per batch × 22 batches ≈ 55s worst-case,
// but the 20s hard cap kicks in well before that.
const sscProbeClient = axios.create({
  timeout: 2500,
  httpsAgent: new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1' as any,
    ciphers: 'DEFAULT@SECLEVEL=0',
  }),
});

// SSCv2 probe paths in priority order
const SSC_PROBE_PATHS = ['/api/device/identity', '/api/ssc/version'];

// Short-lived subscription to make devices respond; 500ms is the min accepted interval
const MCP_PUSH = 'Push 5 500 3';

export class DiscoveryService extends EventEmitter {
  private browsers:    Bonjour[] = [];
  private seenIps      = new Set<string>();        // IPs that have already been emitted
  private deviceNames  = new Map<string, string>(); // ip → real name from MCP Name response
  private anyHandler:  ((raw: string, fromIp: string) => void) | null = null;
  // serial → first IP that claimed it. Prevents the Dante / secondary interface of an
  // EW-DX (which shares the same serial number as the control interface) from appearing
  // as a second device when both NICs are on the same VLAN.
  private seenSerials  = new Map<string, string>();
  private scanInProgress = false;

  constructor() { super(); }

  start() {
    log.debug('[Discovery] Starting passive listeners (mDNS + MCP)...');
    this.startMdns();
    this.startMcpListener();
    // Active scanning (UDP probes + HTTP host sweep) is triggered on-demand via scan().
  }

  // ── On-demand scan ───────────────────────────────────────────────────────

  async scan(): Promise<void> {
    if (this.scanInProgress) {
      log.debug('[Discovery] Scan already in progress, skipping');
      return;
    }
    this.scanInProgress = true;
    this.emit('scan:start');
    log.debug('[Discovery] On-demand scan started');
    try {
      this.runUdpProbes();
      // Hard cap: on Windows, TCP SYN to firewalled hosts can stall far past the
      // per-request timeout. 20s guarantees the spinner always stops.
      const cap = new Promise<void>(resolve => setTimeout(resolve, 20_000));
      await Promise.race([this.runHttpScan(), cap]);
    } finally {
      this.scanInProgress = false;
      this.emit('scan:complete');
      log.debug('[Discovery] On-demand scan complete');
    }
  }

  get isScanning(): boolean { return this.scanInProgress; }

  // ── mDNS (EW-DX and newer firmware) ───────────────────────────────────

  private startMdns() {
    const interfaces = this.getLocalIpv4Addresses();
    const targets = interfaces.length > 0 ? interfaces : [undefined as any];

    for (const iface of targets) {
      const opts = iface ? { interface: iface } : {};
      const bonjour = new Bonjour(opts as any);
      this.browsers.push(bonjour);

      bonjour.find({ type: 'ssc' }, (service: any) => {
        const ip = this.pickIPv4(service);
        if (ip) {
          log.debug(`[Discovery] mDNS _ssc._tcp: ${service.name} at ${ip}:${service.port}`);
          this.emitDiscovered(ip, service.port, service.name, 'ssc');
          this.registerSerial(ip).catch(() => {});
        }
      });

      bonjour.find({ type: 'sennheiser-ssc' }, (service: any) => {
        const ip = this.pickIPv4(service);
        if (ip) {
          log.debug(`[Discovery] mDNS _sennheiser-ssc._tcp: ${service.name} at ${ip}:${service.port}`);
          this.emitDiscovered(ip, service.port, service.name, 'sennheiser-ssc');
          this.registerSerial(ip).catch(() => {});
        }
      });
    }
  }

  // ── MCP passive listener (G3/G4 via shared McpBus) ────────────────────

  private startMcpListener() {
    this.anyHandler = (raw: string, fromIp: string) => {
      // Try to extract a Name line from any MCP packet
      for (const line of raw.split('\r')) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === 'Name' && parts.length >= 2) {
          const name = parts.slice(1).join(' ').trim();
          if (name) {
            const prev = this.deviceNames.get(fromIp);
            this.deviceNames.set(fromIp, name);
            if (this.seenIps.has(`${fromIp}:${MCP_PORT}`) && prev !== name) {
              this.emit('discovered', { ip: fromIp, port: MCP_PORT, name, protocol: 'mcp' } as DiscoveredDevice);
            }
          }
        }
      }

      // Ignore probe commands (ours or another scanner's on the network).
      // A bare "Name\r" or "Push …" is a request, not a device response —
      // real responses carry a value after the keyword ("Name Vocal 1").
      const trimmed = raw.trim();
      if (trimmed === 'Name' || /^Push(\s|$)/.test(trimmed)) return;
      if (!MCP_RESPONSE_RE.test(raw)) return;
      const name = this.deviceNames.get(fromIp) ?? `Sennheiser G3/G4 (${fromIp})`;
      this.emitDiscovered(fromIp, MCP_PORT, name, 'mcp');
    };
    mcpBus.addAnyHandler(this.anyHandler);
  }

  // ── UDP probes (active scan, on-demand only) ───────────────────────────

  private runUdpProbes() {
    // 1. Broadcast probes on all interfaces
    const broadcasts = mcpBus.getBroadcastAddresses();
    log.debug(`[Discovery] UDP probe broadcast to: ${broadcasts.join(', ')}`);
    mcpBus.sendToMany(broadcasts, MCP_PUSH);
    mcpBus.sendToMany(broadcasts, 'Name');

    // 2. Unicast scan per interface
    for (const iface of mcpBus.getActiveInterfaces()) {
      const hostCount = this.subnetHostCount(iface.netmask);
      if (hostCount <= 1022) {
        this.scanRange(iface.address, iface.netmask, hostCount);
      } else {
        const parts = iface.address.split('.');
        const base  = `${parts[0]}.${parts[1]}.${parts[2]}`;
        log.debug(`[Discovery] Large subnet — unicast scan of ${base}.1–254`);
        for (let host = 1; host <= 254; host++) {
          mcpBus.sendTo(`${base}.${host}`, MCP_PUSH);
          mcpBus.sendTo(`${base}.${host}`, 'Name');
        }
      }
    }
  }

  private scanRange(ifaceIp: string, netmask: string, hostCount: number) {
    const maskParts = netmask.split('.').map(Number);
    const ipParts   = ifaceIp.split('.').map(Number);
    const network   = ipParts.map((b, i) => b & maskParts[i]);
    log.debug(`[Discovery] Unicast scan of subnet (${hostCount} hosts)`);
    for (let i = 1; i <= hostCount; i++) {
      const o4 = (network[3] + i) & 0xff;
      const carry3 = Math.floor((network[3] + i) / 256);
      const o3 = (network[2] + carry3) & 0xff;
      const carry2 = Math.floor((network[2] + carry3) / 256);
      const o2 = (network[1] + carry2) & 0xff;
      const o1 = network[0];
      const ip = `${o1}.${o2}.${o3}.${o4}`;
      mcpBus.sendTo(ip, MCP_PUSH);
      mcpBus.sendTo(ip, 'Name');
    }
  }

  // ── HTTP scan (EW-DX / SSCv2, active scan, on-demand only) ──────────

  private async runHttpScan() {
    const ifaces = mcpBus.getActiveInterfaces();
    if (ifaces.length === 0) return;
    log.debug(`[Discovery] HTTP scan across ${ifaces.length} interface(s)…`);
    for (const iface of ifaces) {
      const parts = iface.address.split('.');
      const base  = `${parts[0]}.${parts[1]}.${parts[2]}`;
      const batch: Promise<void>[] = [];
      for (let host = 1; host <= 254; host++) {
        batch.push(this.httpProbeHost(`${base}.${host}`));
        if (batch.length >= 12) {
          await Promise.allSettled(batch.splice(0));
        }
      }
      if (batch.length > 0) await Promise.allSettled(batch);
    }
  }

  private async httpProbeHost(ip: string): Promise<void> {
    const key = `${ip}:${SSC_PORT}`;
    if (this.seenIps.has(key)) return;

    // Probe both SSC paths concurrently — first success wins, halving worst-case time.
    type Hit = { name: string; serial: string | null } | { auth: true };
    const attempt = async (path: string): Promise<Hit> => {
      const url = `https://${ip}:${SSC_PORT}${path}`;
      try {
        const resp = await sscProbeClient.get(url);
        const d    = resp.data;
        if (!d || typeof d !== 'object') throw new Error('non-JSON');
        let name   = `Sennheiser EW-DX (${ip})`;
        const raw  = d.device?.name || d.name || d.identity?.device_name || d.deviceName;
        if (raw && typeof raw === 'string') name = raw;
        const serial = d.serial_number ?? d.serial ?? d.sn ?? null;
        return { name, serial };
      } catch (err: any) {
        if (err.response?.status === 401) return { auth: true };
        throw err;
      }
    };

    let hit: Hit | null = null;
    try {
      hit = await Promise.any(SSC_PROBE_PATHS.map(p => attempt(p)));
    } catch {
      return; // all paths failed — not a Sennheiser device
    }

    if ('auth' in hit) {
      log.debug(`[Discovery] HTTP probe: auth-protected device at ${ip}`);
      this.emitDiscovered(ip, SSC_PORT, `Sennheiser EW-DX (${ip})`, 'ssc');
      return;
    }

    if (hit.serial) {
      const owner = this.seenSerials.get(hit.serial);
      if (owner && owner !== ip) {
        log.debug(`[Discovery] ${ip} shares serial ${hit.serial} with ${owner} — secondary interface, skipping`);
        return;
      }
      this.seenSerials.set(hit.serial, ip);
    }

    log.debug(`[Discovery] HTTP probe found EW-DX at ${ip}: ${hit.name}`);
    this.emitDiscovered(ip, SSC_PORT, hit.name, 'ssc');
  }

  private async registerSerial(ip: string): Promise<void> {
    const url = `https://${ip}:${SSC_PORT}/api/device/identity`;
    try {
      const resp = await sscProbeClient.get(url, { timeout: 2000 });
      const serial = resp.data?.serial_number ?? resp.data?.serial ?? resp.data?.sn ?? null;
      if (serial && !this.seenSerials.has(serial)) {
        this.seenSerials.set(serial, ip);
        log.debug(`[Discovery] Registered serial ${serial} → ${ip}`);
      }
    } catch {
      // Unreachable or auth-required — skip silently
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private emitDiscovered(ip: string, port: number, name: string, protocol: string) {
    const key = `${ip}:${port}`;
    if (this.seenIps.has(key)) return;
    this.seenIps.add(key);
    log.debug(`[Discovery] Found: ${name} at ${ip}:${port} (${protocol})`);
    this.emit('discovered', { ip, port, name, protocol } as DiscoveredDevice);
  }

  private getLocalIpv4Addresses(): string[] {
    return mcpBus.getActiveInterfaces().map(i => i.address);
  }

  private subnetHostCount(netmask: string): number {
    const cidr = netmask.split('.').reduce((acc, octet) => {
      let n = parseInt(octet, 10), bits = 0;
      while (n > 0) { bits += n & 1; n >>= 1; }
      return acc + bits;
    }, 0);
    return Math.max(0, Math.pow(2, 32 - cidr) - 2);
  }

  private pickIPv4(service: any): string | null {
    const re = /^\d{1,3}(\.\d{1,3}){3}$/;
    const v4 = (service.addresses as string[] | undefined)?.find(a => re.test(a));
    if (v4) return v4;
    if (service.host && re.test(service.host)) return service.host;
    return null;
  }

  // Remove a device from seen/name caches so it can be re-discovered after being
  // removed from inventory.  Call for both the inventory port AND port 53212 (MCP).
  forgetDevice(ip: string, port: number) {
    this.seenIps.delete(`${ip}:${port}`);
    this.deviceNames.delete(ip);
    // Clear serial registrations for this IP so an EW-DX coming back at a new IP
    // won't be blocked by the dual-NIC dedup guard.
    for (const [serial, owner] of this.seenSerials) {
      if (owner === ip) this.seenSerials.delete(serial);
    }
  }

  stop() {
    for (const b of this.browsers) { try { b.destroy(); } catch { /* ignore */ } }
    this.browsers = [];
    if (this.anyHandler) { mcpBus.removeAnyHandler(this.anyHandler); this.anyHandler = null; }
  }
}
