import Bonjour from 'bonjour-service';
import os from 'os';
import https from 'https';
import tls from 'tls';
import axios from 'axios';
import { EventEmitter } from 'events';
import { mcpBus } from './McpBus';
import { ShureSlpListener } from '../shure/slp';
import { probeShure, describeIdentity, logIdentity } from '../shure/probe';
import { log } from '../../logger';

export interface DiscoveredDevice {
  ip: string;
  port: number;
  name: string;
  protocol: 'ssc' | 'sennheiser-ssc' | 'mcp' | 'shure' | string;
  /**
   * Set when discovery already knows, rather than inferring from the name.
   *
   * The Sennheiser paths leave these undefined and let the name heuristics in
   * plugins/socket.ts do the work. The Shure path probes the device before
   * announcing it, so guessing would be throwing away a real answer — and for
   * Shure the model is not cosmetic: it selects the command vocabulary and the
   * channel count. A device called "Rack1" would otherwise be filed as a
   * receiver of model "Rack1".
   */
  manufacturer?: string;
  model?: string;
}

const MCP_PORT = 53212;
const SSC_PORT  = 443;
const SHURE_PORT = 2202;

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

// ── Is this actually a Sennheiser device? ────────────────────────────────────
//
// Probing an unknown host for two API paths is not identification. Plenty of
// things on a venue network answer HTTPS on 443 — routers, NAS boxes, cameras,
// printers, hypervisors — and most return 401 on an unknown path, or return
// JSON that has nothing to do with SSC. Treating either as proof produced a
// discovery list full of devices that were never Sennheiser.
//
// A host is only claimed when something positively identifies it:
//   • the response body names Sennheiser, or an SSC/EW product, or carries a
//     structure only SSC serves, or
//   • the TLS certificate names Sennheiser.
//
// Anything else is skipped, and logged at debug so a genuine device that is
// being missed can still be diagnosed.

const VENDOR_RE  = /sennheiser/i;
// EW-DX, EW-D, EM 2/4, SKM, SK, EM 6000, EM 9046, and the G3/G4 EM families.
const PRODUCT_RE = /\b(ew[\s-]?dx|ew[\s-]?d\b|ewdx|em[\s-]?\d+|skm[\s-]?\d+|sk[\s-]?\d+|ebp|evolution\s?wireless)\b/i;

function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

// Does this JSON body identify a Sennheiser SSC device?
export function bodyIdentifiesSennheiser(d: any): boolean {
  if (!d || typeof d !== 'object') return false;

  // Explicit vendor field is the strongest signal — SSC's /api/device/identity
  // carries one.
  const vendorFields = [d.vendor, d.manufacturer, d.make, d.brand,
                        d.device?.vendor, d.identity?.vendor];
  if (vendorFields.some(v => VENDOR_RE.test(textOf(v)))) return true;

  // Product/model naming an EW or EM family unit.
  const productFields = [d.product, d.model, d.device?.product, d.device?.model,
                         d.identity?.product, d.name, d.device?.name, d.deviceName];
  if (productFields.some(v => PRODUCT_RE.test(textOf(v)) || VENDOR_RE.test(textOf(v)))) return true;

  // SSC-specific shapes. Per the SSCv2 specification, /api/ssc/version returns
  // exactly {"protocol": "2.0", "schema": "1.5"} — there is no vendor field and
  // no `ssc` key, so without this rule a genuine EW-DX answering that endpoint
  // was rejected as "not SSC". Some firmware carries an `ssc` key instead.
  const versionLike = (v: unknown) => typeof v === 'string' && /^\d+(\.\d+)*$/.test(v);
  if (versionLike(d.protocol) && versionLike(d.schema)) return true;
  if (d.ssc !== undefined) return true;

  return false;
}

// Short-lived subscription to make devices respond; 500ms is the min accepted interval
const MCP_PUSH = 'Push 5 500 3';

export class DiscoveryService extends EventEmitter {
  private browsers:    Bonjour[] = [];
  private shureSlp:    ShureSlpListener | null = null;
  // Announcements repeat every few seconds. Probing on each one would mean a
  // TCP connection per device per announcement, forever.
  private shureProbed  = new Set<string>();
  private seenIps      = new Set<string>();        // IPs that have already been emitted
  private deviceNames  = new Map<string, string>(); // ip → real name from MCP Name response
  private anyHandler:  ((raw: string, fromIp: string) => void) | null = null;
  // serial → first IP that claimed it. Prevents the Dante / secondary interface of an
  // EW-DX (which shares the same serial number as the control interface) from appearing
  // as a second device when both NICs are on the same VLAN.
  private seenSerials  = new Map<string, string>();
  private scanInProgress = false;

  constructor() { super(); }

  // Off by default; set only by the end-to-end harness. Discovery broadcasts
  // on the network and sweeps the subnet, which makes a test run slow, noisy,
  // and dependent on whatever else is plugged in — none of which the tests are
  // about. Nothing in a deployment sets this.
  private get disabled(): boolean {
    return process.env.RFDECK_DISABLE_DISCOVERY === '1';
  }

  start() {
    if (this.disabled) {
      log.warn('[Discovery] Disabled by RFDECK_DISABLE_DISCOVERY — no devices will be found');
      return;
    }
    log.debug('[Discovery] Starting passive listeners (mDNS + MCP + Shure SLP)...');
    this.startMdns();
    this.startMcpListener();
    this.startShureListener();
    // Active scanning (UDP probes + HTTP host sweep) is triggered on-demand via scan().
  }

  // ── On-demand scan ───────────────────────────────────────────────────────

  async scan(): Promise<void> {
    if (this.disabled) return;
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

  // ── Shure SLP passive listener ────────────────────────────────────────
  //
  // Shure receivers announce themselves on a multicast group. The announcement
  // says where a device is but not usefully what it is — the model hides
  // behind a device class id that maps through a proprietary file RFDeck does
  // not have — so the address is treated as a candidate and confirmed by
  // asking the device directly on 2202.
  //
  // Exactly the shape of the G3/G4 path above: listen passively, then probe.
  // An open port is not identification, and neither is a multicast packet.

  private startShureListener() {
    const listener = new ShureSlpListener();
    this.shureSlp = listener;

    listener.on('announce', ({ ip }: { ip: string }) => {
      if (this.shureProbed.has(ip)) return;
      if (this.seenIps.has(`${ip}:${SHURE_PORT}`)) return;
      // Claim the address before the probe, not after: announcements repeat
      // every few seconds and an in-flight probe would otherwise be started
      // again on each one.
      this.shureProbed.add(ip);

      probeShure(ip, SHURE_PORT)
        .then(identity => {
          if (!identity) {
            // Announced on Shure's group but does not speak command strings —
            // an older model, or something else entirely. Allowed to be
            // retried later, since this may be a device still booting.
            this.shureProbed.delete(ip);
            log.debug(`[Discovery] ${ip} announced on the Shure group but did not answer on ${SHURE_PORT}`);
            return;
          }
          logIdentity(ip, identity);
          this.emitDiscovered(
            ip, SHURE_PORT, describeIdentity(identity, ip), 'shure',
            // The probe asked the device; nothing downstream should guess.
            { manufacturer: 'Shure', model: identity.model ?? undefined },
          );
        })
        .catch(() => { this.shureProbed.delete(ip); });
    });

    listener.start(this.getLocalIpv4Addresses());
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

  // Read the TLS certificate without completing an HTTP request. Sennheiser
  // devices present a self-signed cert that names them, which identifies a unit
  // whose API is behind auth and would otherwise answer nothing but 401.
  private async certificateIdentifiesSennheiser(ip: string): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (result: boolean) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* ignore */ }
        resolve(result);
      };

      const socket = tls.connect({
        host: ip,
        port: SSC_PORT,
        rejectUnauthorized: false,
        minVersion: 'TLSv1' as any,
        ciphers: 'DEFAULT@SECLEVEL=0',
        timeout: 2500,
      }, () => {
        try {
          const cert: any = socket.getPeerCertificate();
          if (!cert) return done(false);
          // Subject and issuer both matter: some units are signed by a
          // Sennheiser CA while the leaf names only the serial.
          const fields = [
            cert.subject?.CN, cert.subject?.O, cert.subject?.OU,
            cert.issuer?.CN,  cert.issuer?.O,  cert.issuer?.OU,
          ].filter(Boolean).join(' ');
          done(VENDOR_RE.test(fields) || PRODUCT_RE.test(fields));
        } catch {
          done(false);
        }
      });

      socket.on('error',   () => done(false));
      socket.on('timeout', () => done(false));
    });
  }

  private async httpProbeHost(ip: string): Promise<void> {
    const key = `${ip}:${SSC_PORT}`;
    if (this.seenIps.has(key)) return;

    // Probe both SSC paths concurrently, but decide only once BOTH have answered.
    //
    // The two are not interchangeable, so the first to respond must not settle
    // the question. Per the SSCv2 specification, /api/ssc/version is gated by
    // auth and returns only {protocol, schema}, while /api/device/identity
    // carries the vendor string and may answer without auth. Taking the first
    // result — as this used to — let a quick 401 from the version endpoint win
    // the race and discard a positive identification still in flight from the
    // identity endpoint. A real EW-DX disappeared from discovery that way.
    type BodyHit = { kind: 'body'; data: any; name: string; serial: string | null };
    type Hit = BodyHit | { kind: 'auth' };

    const attempt = async (path: string): Promise<Hit> => {
      const url = `https://${ip}:${SSC_PORT}${path}`;
      try {
        const resp = await sscProbeClient.get(url);
        const d    = resp.data;
        if (!d || typeof d !== 'object') throw new Error('non-JSON');
        let name   = `Sennheiser EW-DX (${ip})`;
        // The identity endpoint has no name field but does carry the product
        // designation ("as on the label"), which is a better label than nothing.
        const raw  = d.device?.name || d.name || d.identity?.device_name || d.deviceName || d.product;
        if (raw && typeof raw === 'string') name = raw;
        const serial = d.serial_number ?? d.serial ?? d.sn ?? null;
        return { kind: 'body', data: d, name, serial };
      } catch (err: any) {
        // 401 means *something* is there, but says nothing about what. Carry it
        // forward as a weak signal to be confirmed against the certificate.
        if (err.response?.status === 401) return { kind: 'auth' };
        throw err;
      }
    };

    const settled = await Promise.allSettled(SSC_PROBE_PATHS.map(p => attempt(p)));
    const hits = settled
      .filter((s): s is PromiseFulfilledResult<Hit> => s.status === 'fulfilled')
      .map(s => s.value);
    if (hits.length === 0) return; // nothing answered — not a Sennheiser device

    const bodies = hits.filter((h): h is BodyHit => h.kind === 'body');
    const identifying = bodies.filter(b => bodyIdentifiesSennheiser(b.data));

    // Prefer the body that carries a serial: it is what the secondary-interface
    // dedupe below keys on, and only the identity endpoint provides one.
    let hit: BodyHit | null = identifying.find(b => b.serial) ?? identifying[0] ?? null;

    if (!hit) {
      // Nothing in the bodies names the vendor — auth-only, or JSON that any
      // appliance might return. The certificate is the remaining evidence.
      if (!(await this.certificateIdentifiesSennheiser(ip))) {
        const summary = bodies.length > 0
          ? `response is not SSC (${JSON.stringify(bodies[0].data).slice(0, 120)})`
          : 'HTTPS 401 on every path';
        log.debug(`[Discovery] ${ip}: ${summary} and the certificate does not identify Sennheiser — skipping`);
        return;
      }
      log.debug(`[Discovery] ${ip}: TLS certificate identifies Sennheiser`);
      hit = bodies[0] ?? null;
    }

    const name   = hit?.name   ?? `Sennheiser EW-DX (${ip})`;
    const serial = hit?.serial ?? null;

    if (serial) {
      const owner = this.seenSerials.get(serial);
      if (owner && owner !== ip) {
        log.debug(`[Discovery] ${ip} shares serial ${serial} with ${owner} — secondary interface, skipping`);
        return;
      }
      this.seenSerials.set(serial, ip);
    }

    log.debug(`[Discovery] HTTP probe found EW-DX at ${ip}: ${name}`);
    this.emitDiscovered(ip, SSC_PORT, name, 'ssc');
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

  private emitDiscovered(
    ip: string, port: number, name: string, protocol: string,
    known: { manufacturer?: string; model?: string } = {},
  ) {
    const key = `${ip}:${port}`;
    if (this.seenIps.has(key)) return;
    this.seenIps.add(key);
    log.debug(`[Discovery] Found: ${name} at ${ip}:${port} (${protocol})`);
    this.emit('discovered', { ip, port, name, protocol, ...known } as DiscoveredDevice);
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
    // Also clear the probe record, or a removed Shure device would announce
    // itself forever without ever being offered again.
    this.shureProbed.delete(ip);
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
    this.shureSlp?.stop();
    this.shureSlp = null;
    this.shureProbed.clear();
  }
}
