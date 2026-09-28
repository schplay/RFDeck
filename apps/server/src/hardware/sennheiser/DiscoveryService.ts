import Bonjour from 'bonjour-service';
import os from 'os';
import https from 'https';
import tls from 'tls';
import net from 'net';
import axios from 'axios';
import { EventEmitter } from 'events';
import { mcpBus } from './McpBus';
import { ShureSlpListener } from '../shure/slp';
import { probeShure, describeIdentity, logIdentity } from '../shure/probe';
import { log } from '../../logger';
import { IgnoreRule, parseIgnoreList, isIgnored } from './discoveryIgnore';

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

/**
 * Whether discovery should be suppressed, decided once at startup.
 *
 * Only the end-to-end harness ever wants this, and a deployment must never be
 * able to end up in that state — not through a stray variable inherited from a
 * parent process, not through a copied service file, not through someone
 * exporting it in a shell to debug something else. So the switch is refused
 * outright in production and says loudly that it was refused.
 *
 * A silent global off-switch for the product's core function is not a feature.
 */
export function resolveDiscoveryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RFDECK_DISABLE_DISCOVERY !== '1') return false;
  if (env.NODE_ENV === 'production') {
    log.error(
      '[Discovery] RFDECK_DISABLE_DISCOVERY is set on a production server and ' +
      'is being IGNORED. It exists for the test harness. Discovery stays on — ' +
      'a deployment that cannot find receivers is not something to switch on by accident.',
    );
    return false;
  }
  log.warn('[Discovery] Disabled for testing — no devices will be found');
  return true;
}

/** The UDP port G3/G4 receivers speak MCP on. Exported because the inventory
 *  stores it, and it is the one unambiguous "this is a G3" signal. */
export const MCP_PORT = 53212;
const SSC_PORT  = 443;
const SHURE_PORT = 2202;

// How long to wait for a bare TCP connect when sweeping a subnet. A host that
// is present answers a LAN connect in milliseconds; this only bounds the wait
// for addresses that swallow packets rather than refusing them.
const HOST_PROBE_TIMEOUT_MS = 400;

// How many connects are in flight at once while sweeping.
//
// This was 512, chosen by measuring how fast a /16 could be swept. That was the
// wrong thing to optimise. Five hundred simultaneous half-open connections is
// enough to exhaust the connection-tracking table on an ordinary venue router,
// and when a sweep repeats every minute — which it does for as long as a device
// is missing — the effect is continuous. It showed up as the server's own
// outbound connections failing: git fetches timing out on a network with nothing
// else wrong with it.
//
// RFDeck is a guest on somebody's show network. But 48 was an over-correction in
// the other direction: a bare connect to an empty address fails immediately on a
// LAN, so most of a sweep costs nothing, and cutting concurrency this far mainly
// slows the part that was already cheap — while pushing a large network's sweep
// past the point where it finishes at all.
//
// 256 halves the peak connection pressure against the measured figure and still
// walks a /16 well inside its guard. The repetition was always the larger part of
// the problem, and that is fixed where it belongs, in how often a sweep runs.
const HOST_PROBE_CONCURRENCY = 256;

// Upper bound on one sweep, so a scan can never hang forever — derived from the
// size of the sweep rather than fixed.
//
// A fixed three minutes was quietly an assumption about how big a network is. It
// held for a /16 at the concurrency of the day and would have silently truncated
// the sweep the moment either changed: addresses beyond the cut would never be
// probed, and a receiver sitting on one would be undiscoverable with nothing to
// say why. That is the same class of fault as the original 20-second cap this
// replaced.
//
// Networks are not ours to predict. The guard now scales with the work: the time
// the sweep would take if *every* address were a silent host paying the full
// connect timeout, which is the worst case, plus a generous floor for small
// networks where the fixed costs dominate.
const SCAN_GUARD_FLOOR_MS = 180_000;

export function scanGuardMs(addressCount: number): number {
  const worstCase = Math.ceil(addressCount / HOST_PROBE_CONCURRENCY) * HOST_PROBE_TIMEOUT_MS;
  return Math.max(SCAN_GUARD_FLOOR_MS, worstCase * 2);
}

// The probe that makes a G3/G4 answer: a five-second subscription, the shortest
// the protocol takes. Discovery has no use for a long one — it wants a reply, not
// a stream — and a short window is what limits what a host that is not a receiver
// is asked to do.
const MCP_PROBE = 'Push 5 500 3';

// A valid MCP response line starts with one of these tokens
const MCP_RESPONSE_RE = /^(States|AF|RF1|RF2|RF|Bat|Frequency|Name|Msg)\s/m;

// Shared HTTPS client for probing EW-DX devices (self-signed certs, legacy TLS).
// 2500ms gives embedded firmware enough time to complete the TLS handshake.
// Only ever aimed at addresses already known to be listening on 443, so this
// timeout is paid a handful of times per scan rather than 254 times.
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

export class DiscoveryService extends EventEmitter {
  private browsers:    Bonjour[] = [];
  private shureSlp:    ShureSlpListener | null = null;
  // Announcements repeat every few seconds. Probing on each one would mean a
  // TCP connection per device per announcement, forever.
  private shureProbed  = new Set<string>();
  // Addresses already reported as found-but-not-offered, so the repeating
  // scans do not repeat the warning.
  private notOfferedReported = new Set<string>();
  private seenIps      = new Set<string>();        // IPs that have already been emitted
  private deviceNames  = new Map<string, string>(); // ip → real name from MCP Name response
  private anyHandler:  ((raw: string, fromIp: string) => void) | null = null;
  // serial → first IP that claimed it. Prevents the Dante / secondary interface of an
  // EW-DX (which shares the same serial number as the control interface) from appearing
  // as a second device when both NICs are on the same VLAN.
  private seenSerials  = new Map<string, string>();

  /**
   * Where RFDeck's own devices were last seen.
   *
   * The sweep walked the subnets of the server's network interfaces and nothing
   * else, which is only the same thing when every receiver shares a subnet with
   * the server. A rig routed onto its own VLAN, or a device that moved across
   * one, was never probed at all — no discovery, no log line, nothing to explain
   * it. The operator was left retyping an address RFDeck had every means to find.
   *
   * An inventory row's address is evidence about where its hardware lives, and it
   * stays true across the DHCP change that invalidated the host part. So the /24
   * around each known device is searched as well.
   */
  private searchHints: string[] = [];

  /** Told by the device manager, which is the half of RFDeck that has the inventory. */
  setSearchHints(ips: string[]): void {
    this.searchHints = [...new Set(ips.filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip)))];
  }

  /**
   * Every address worth sweeping: the interfaces' own subnets, plus the /24 around
   * each place a device was last seen that those subnets do not already reach.
   */
  private sweepTargets(): Array<{ label: string; addresses: string[] }> {
    const targets: Array<{ label: string; addresses: string[] }> = [];
    const covered = new Set<string>();

    for (const iface of mcpBus.getActiveInterfaces()) {
      const addresses = this.subnetAddresses(iface);
      for (const a of addresses) covered.add(a);
      targets.push({ label: `interface ${iface.address}`, addresses });
    }

    const extra = new Map<string, string[]>();
    for (const hint of this.searchHints) {
      if (covered.has(hint)) continue;           // already in an interface subnet
      const base = hint.split('.').slice(0, 3).join('.');
      if (extra.has(base)) continue;
      extra.set(base, Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`));
    }
    for (const [base, addresses] of extra) {
      targets.push({ label: `${base}.0/24, where a device was last seen`, addresses });
    }
    return targets;
  }

  /**
   * Addresses already settled this session, and how.
   *
   * Not a cache with an expiry — that was an arbitrary half hour that also meant a
   * receiver plugged in five minutes after a scan was ignored for the rest of it.
   * This is a record of work already done, cleared by the events that make it
   * stale: the operator pressing Rescan, or the host turning out to be a device
   * after all.
   *
   * It holds only "this is not a Sennheiser device", a verdict from an
   * unauthenticated probe that nothing here can change its mind about. Whether a
   * password-protected host is worth another attempt depends on the passwords,
   * which this class does not have — that decision belongs to the listener.
   *
   * It exists because a sweep is not cheap. While a device is missing RFDeck scans
   * about once a minute, and without this every scan re-opens a TLS connection to
   * every appliance on the network and re-presents credentials to every host that
   * asked for them. That work competes with the polling that produces audio levels
   * and RF, and it showed: telemetry went visibly laggy the moment this was
   * removed.
   *
   * An address never seen before is always probed, so new hardware is still found
   * without anyone asking.
   */
  private settled = new Map<string, 'not-sennheiser'>();
  private scanInProgress = false;

  // Addresses the operator has told RFDeck to leave alone. Applied before any
  // socket is opened, not to the results afterwards.
  private ignoreRules: IgnoreRule[] = [];

  // Hosts that answered on 443 and turned out not to be Sennheiser.
  //
  // Identification is not free: two HTTPS GETs and, when those are
  // inconclusive, a TLS handshake to read the certificate. Repeating that on
  // every scan — three at startup, then one a minute for as long as any
  // tracked device is unreachable — meant RFDeck presenting unauthenticated
  // requests to the same NAS, camera or hypervisor indefinitely. The verdict
  // is remembered and not revisited for a while; an operator asking for a
  // scan from the Add Device dialog clears it, because that is the moment
  // they are telling RFDeck that something on the network has changed.

  private readonly disabled: boolean;

  /**
   * @param disabled Suppress all discovery. For the end-to-end harness only,
   *   which must not broadcast and sweep a real subnet on every run.
   *
   * Passed in rather than read from the environment here. It used to be an
   * ambient `process.env.RFDECK_DISABLE_DISCOVERY` check in the middle of this
   * class, which meant a single stray variable in a service environment could
   * turn off the one thing RFDeck exists to do, anywhere, with nothing but a
   * log line to say so. Finding devices is not something that should be
   * switchable by accident. The decision is now made once, at startup, by code
   * that knows whether this is a deployment — see resolveDiscoveryDisabled.
   */
  constructor(disabled = false) {
    super();
    this.disabled = disabled;
  }

  start() {
    if (this.disabled) {
      log.warn('[Discovery] Suppressed by the test harness — no devices will be found');
      return;
    }
    log.debug('[Discovery] Starting passive listeners (mDNS + MCP + Shure SLP)...');
    this.startMdns();
    this.startMcpListener();
    this.startShureListener();
    // Active scanning (UDP probes + HTTP host sweep) is triggered on-demand via scan().
  }

  /**
   * Which addresses discovery must never contact.
   *
   * Takes effect immediately, including on a scan already running — the point
   * is that RFDeck stops touching someone else's equipment, and "after the
   * current sweep finishes" is not that.
   */
  setIgnoreList(spec: string | null | undefined): void {
    this.ignoreRules = parseIgnoreList(spec);
    if (this.ignoreRules.length > 0) {
      log.info(
        `[Discovery] Not contacting ${this.ignoreRules.map(r => r.text).join(', ')} — ` +
        `excluded in Settings`,
      );
    }
  }

  /** Excluded by the operator, so nothing is ever sent to it. */
  private excluded(ip: string): boolean {
    return isIgnored(ip, this.ignoreRules);
  }

  // ── On-demand scan ───────────────────────────────────────────────────────

  /**
   * @param operatorRequested The operator pressed Rescan rather than this being a
   *   startup or recovery sweep. Only affects what is logged: a scan looks at
   *   every address either way.
   */
  async scan(operatorRequested = false): Promise<void> {
    if (operatorRequested && this.settled.size > 0) {
      // "Look again" means what it says: forget every verdict and every address
      // already tried with credentials.
      log.debug(`[Discovery] Operator rescan — reconsidering ${this.settled.size} address(es)`);
      this.settled.clear();
    }
    if (this.disabled) return;
    if (this.scanInProgress) {
      log.debug('[Discovery] Scan already in progress, skipping');
      return;
    }
    this.scanInProgress = true;
    this.emit('scan:start');
    log.debug('[Discovery] On-demand scan started');
    const before = this.seenIps.size;
    try {
      this.runUdpProbes();
      // A guard against a sweep that never returns, not a deadline for one that
      // is working.
      //
      // This was 20 seconds, chosen when a sweep was a /24 and each address
      // cost a full TLS timeout. It then had to be exceeded by every ordinary
      // scan, so "scan complete" was announced while the sweep was still
      // running and a receiver reached afterwards arrived to an audience that
      // had already been told there was nothing there.
      //
      // Sized from the sweep itself, so a large network is never cut off partway
      // and a small one is not held open. The per-address stall the original cap
      // existed for is handled where it belongs, by the connect timeout in
      // hostsListeningOn.
      const total = this.sweepTargets().reduce((n, t) => n + t.addresses.length, 0);
      const guardMs = scanGuardMs(total);
      log.debug(`[Discovery] Sweeping ${total} address(es); guard ${Math.round(guardMs / 1000)}s`);
      const cap = new Promise<void>(resolve => setTimeout(resolve, guardMs));
      await Promise.race([this.runHttpScan(), cap]);
    } finally {
      this.scanInProgress = false;
      this.emit('scan:complete');
      // What a scan actually did, at a level a deployed server prints.
      //
      // Silence here was the root of an unfalsifiable question: with nothing in
      // the journal, "discovery found nothing" and "discovery was never asked"
      // and "discovery found it and withheld it" all look identical. One line
      // per scan is a price worth paying to tell them apart — and a scan that
      // sweeps every subnet and finds not one device is worth saying out loud,
      // because on a rig with receivers plugged in it is almost always a
      // blocked port rather than an empty network.
      const found = this.seenIps.size - before;
      const nets  = this.getLocalIpv4Addresses();
      if (found > 0) {
        log.warn(`[Discovery] Scan complete — ${found} new device(s) found`);
      } else if (this.seenIps.size === 0) {
        log.warn(
          `[Discovery] Scan complete — no devices found on any interface ` +
          `(${nets.join(', ') || 'none detected'}). If receivers are on this ` +
          `network, check that UDP 5353 and 53212 are open and that the server ` +
          `is on the same subnet or VLAN as the rack.`,
        );
      } else {
        log.debug('[Discovery] Scan complete — nothing new');
      }
    }
  }

  get isScanning(): boolean { return this.scanInProgress; }

  // ── mDNS (EW-DX and newer firmware) ───────────────────────────────────

  private startMdns() {
    const interfaces = this.getLocalIpv4Addresses();
    const targets = interfaces.length > 0 ? interfaces : [undefined as any];

    // Which interfaces are being listened on, once, at startup.
    //
    // An EW-DX is found over mDNS; a G3 is found over the MCP broadcast. When
    // the first fails and the second works, the first question is whether mDNS
    // was ever listening on the subnet the receiver is on — and there was no
    // way to answer it from a deployed server, because this was silent.
    if (interfaces.length > 0) {
      log.warn(`[Discovery] Listening for EW-DX (mDNS) on ${interfaces.join(', ')}`);
    } else {
      log.warn(
        '[Discovery] No usable network interface found — listening for EW-DX on ' +
        'the default route only. Receivers on another subnet will not be found.',
      );
    }

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
      if (this.excluded(ip)) return;
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

  /**
   * Look for G3/G4 receivers.
   *
   * ── What this must not do, and what it turned out it must ────────────────
   *
   * This used to send two datagrams to **every address on the subnet** — up to
   * 1022 per interface — and one of them was `Push`, which is not a question but
   * a *subscription command*. It ran three times at startup and once a minute for
   * as long as any device was unreachable.
   *
   * ArtNet and sACN nodes were locking up and crashing. Lighting controllers have
   * small embedded stacks, and a repeated unsolicited unicast flood is enough to
   * do it whatever port it names. RFDeck has no business issuing device commands
   * to hardware that has never said it is a receiver.
   *
   * Removing `Push` outright was tried and was wrong: it is what makes a G3/G4
   * talk. Without it every G3 and G4 went silent — not discovered, not connected,
   * and Network Scan came back empty. The protocol does not offer a politer way
   * to ask.
   *
   * So the subscription is back, and the thing that actually caused harm is dealt
   * with where it belongs: how often this runs. A sweep repeated every twenty
   * seconds for as long as any device was missing, which on a rig switched off
   * overnight is permanent. The gap between automatic sweeps now backs off to
   * minutes, and the subscription requested here is a five-second one, so a host
   * that is not a receiver sees two datagrams occasionally rather than a
   * continuous stream of commands.
   *
   * The per-host unicast sweep stays, because a receiver that has moved to another
   * subnet is exactly what it is for and nobody should have to press a button to
   * get their rig back. What makes it acceptable is *when* it runs: a scan happens
   * at startup, or because a tracked device is unreachable, or because the operator
   * asked — never while the rig is healthy. RFDeck looks for hardware when it is
   * missing hardware, and otherwise leaves the network alone.
   */
  private runUdpProbes() {
    const broadcasts = mcpBus.getBroadcastAddresses();
    log.debug(`[Discovery] MCP broadcast probe to: ${broadcasts.join(', ')}`);
    mcpBus.sendToMany(broadcasts, MCP_PROBE);
    mcpBus.sendToMany(broadcasts, 'Name');

    // `Name` only here too — a receiver on another subnet, where broadcast does
    // not reach, is exactly why this exists, and it is still not a reason to
    // command anything.
    //
    // Same target set as the HTTP sweep: the interfaces' subnets *and* the /24
    // around each place a device was last seen. A G3 that moved across a VLAN was
    // as invisible as an EW-DX that did.
    for (const { addresses } of this.sweepTargets()) {
      for (const ip of addresses) {
        if (this.excluded(ip)) continue;
        mcpBus.sendTo(ip, MCP_PROBE);
        mcpBus.sendTo(ip, 'Name');
      }
    }
  }



  // ── HTTP scan (EW-DX / SSCv2, active scan, on-demand only) ──────────

  /**
   * Every address on this interface's subnet, nearest first.
   *
   * The sweep used to take the interface address, keep the first three octets
   * and walk .1 to .254 — a /24, always, whatever the interface actually said.
   * A venue network is routinely a /16: the one this was diagnosed on carries
   * hosts across 10.2.0, 10.2.1, 10.2.2, 10.2.3, 10.2.5 and 10.2.25. A server
   * on 10.2.0.x therefore never looked at 10.2.2.148, where the EW-DX was, and
   * no amount of scanning would ever have found it.
   *
   * That is also why this looked like a regression with nothing in the diffs to
   * show for it. Nothing changed in the code: a DHCP lease moved the server or
   * the receiver into a different third octet, and EW-DX discovery stopped —
   * while the G3s carried on, because MCP is a broadcast and reaches the whole
   * subnet regardless of where either end sits in it.
   *
   * Ordered with the interface's own /24 first, so the common case still
   * resolves in the first couple of seconds and devices appear while the rest
   * of the range is still being swept.
   */
  private subnetAddresses(iface: { address: string; netmask: string }): string[] {
    const hosts = this.subnetHostCount(iface.netmask);
    const parts = iface.address.split('.').map(Number);
    const local = `${parts[0]}.${parts[1]}.${parts[2]}`;

    // Anything wider than a /16 is not a LAN worth walking address by address;
    // 16.7m probes would take days. Sweep what is nearby and say so, rather
    // than pretending to have covered it.
    if (hosts > 65_536) {
      log.warn(
        `[Discovery] ${iface.address}/${iface.netmask} is larger than a /16 — ` +
        `sweeping ${local}.0/24 only. Receivers elsewhere on it must be added by IP.`,
      );
      return Array.from({ length: 254 }, (_, i) => `${local}.${i + 1}`);
    }

    const mask = iface.netmask.split('.').map(Number);
    const net0 = parts.map((b, i) => b & mask[i]);
    const all: string[] = [];
    for (let i = 1; i <= hosts; i++) {
      const d = (net0[3] + i) & 0xff;
      const c = (net0[2] + Math.floor((net0[3] + i) / 256)) & 0xff;
      const b = (net0[1] + Math.floor((net0[2] + Math.floor((net0[3] + i) / 256)) / 256)) & 0xff;
      all.push(`${net0[0]}.${b}.${c}.${d}`);
    }
    // Nearest first: the receiver is usually on the same /24 as the server, and
    // when it is, the whole thing is over in two seconds.
    const near = all.filter(a => a.startsWith(`${local}.`));
    const far  = all.filter(a => !a.startsWith(`${local}.`));
    // Excluded addresses never reach the sweep, so not even a bare TCP connect
    // is opened to them.
    return [...near, ...far].filter(a => !this.excluded(a));
  }

  /**
   * Which of these addresses have anything listening on a port.
   *
   * A bare TCP connect: one socket, no bytes, no TLS. An address with nothing
   * on it fails immediately on a LAN rather than waiting out a timeout, so the
   * cost is dominated by the few that silently drop packets.
   *
   * Concurrency is deliberately bounded and deliberately not large. Measured on
   * the network this was diagnosed on, 512 at a time swept a full /16 in 51
   * seconds and found every host; 2048 at a time exhausted the socket table and
   * every single connect failed, reporting a completely empty network in 15
   * seconds. A sweep that finds nothing looks exactly like a sweep that found
   * nothing, so being wrong here is silent, and faster is not better.
   */
  private async hostsListeningOn(
    addresses: string[],
    port: number,
    onFound: (ip: string) => void,
  ): Promise<string[]> {
    const found: string[] = [];
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < addresses.length) {
        const ip = addresses[next++];
        await new Promise<void>(resolve => {
          const sock = new net.Socket();
          let settled = false;
          const done = (listening: boolean) => {
            if (settled) return;
            settled = true;
            sock.destroy();
            if (listening) { found.push(ip); onFound(ip); }
            resolve();
          };
          sock.setTimeout(HOST_PROBE_TIMEOUT_MS);
          sock.once('connect', () => done(true));
          sock.once('timeout', () => done(false));
          sock.once('error',   () => done(false));
          sock.connect(port, ip);
        });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(HOST_PROBE_CONCURRENCY, addresses.length) }, worker),
    );
    return found;
  }

  // Find the EW-DX receivers on each attached subnet.
  //
  // Two stages, because the expensive part is only worth spending on addresses
  // that exist. This used to open an HTTPS request to all 254 addresses, twelve
  // at a time, and every empty address cost the full 2.5-second TLS timeout —
  // about 55 seconds to cross a /24. The scan is capped at 20 seconds, so it
  // was routinely cut off less than half way, and a receiver in the upper half
  // of the range was reported as "scan complete, nothing found". On the network
  // this was diagnosed on, the EW-DX at .148 was reached 31 seconds in: found,
  // reliably, eleven seconds after RFDeck had already said there was nothing
  // there.
  //
  // A TCP connect first narrows 254 addresses to the handful that answer on
  // 443, in about three seconds, and only those get identified. The whole sweep
  // now finishes well inside the cap, which is the difference between a cap
  // that guards against a pathological network and one that silently truncates
  // every normal scan.
  private async runHttpScan() {
    const targets = this.sweepTargets();
    if (targets.length === 0) return;
    log.debug(`[Discovery] HTTP scan across ${targets.length} range(s)…`);
    for (const { label, addresses } of targets) {
      log.debug(`[Discovery] Sweeping ${addresses.length} address(es) from ${label}`);

      // Identify each host the moment the sweep reaches it, rather than
      // collecting the whole subnet first. On a /16 the sweep takes the better
      // part of a minute, and holding every result until the end would mean a
      // receiver sitting in the list of found addresses, already known, waiting
      // on 65,000 dead ones before anybody was told about it.
      const identifying: Promise<void>[] = [];
      const candidates = await this.hostsListeningOn(addresses, SSC_PORT, ip => {
        identifying.push(this.httpProbeHost(ip).catch(() => {}));
      });
      await Promise.allSettled(identifying);

      log.debug(
        `[Discovery] ${candidates.length} host(s) answering on ${SSC_PORT}` +
        `${candidates.length ? ` (${candidates.join(', ')})` : ''}`,
      );
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
    // Already judged this session. See `settled`.
    if (this.settled.get(ip) === 'not-sennheiser') return;

    const key = `${ip}:${SSC_PORT}`;
    if (this.seenIps.has(key)) return;
    // Asked and answered. Re-presenting unauthenticated requests to a host
    // that has already said it is not a receiver is the part of discovery
    // that is nobody else's problem to put up with.
    if (this.excluded(ip)) return;

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
    if (hits.length === 0) {
      // Something is listening on 443 but neither SSC path answered — a web UI,
      // a NAS, an appliance. Remembered for this session so the next sweep does
      // not open another TLS connection to it.
      this.settled.set(ip, 'not-sennheiser');
      return;
    }

    const bodies = hits.filter((h): h is BodyHit => h.kind === 'body');
    const identifying = bodies.filter(b => bodyIdentifiesSennheiser(b.data));

    // Prefer the body that carries a serial: it is what the secondary-interface
    // dedupe below keys on, and only the identity endpoint provides one.
    let hit: BodyHit | null = identifying.find(b => b.serial) ?? identifying[0] ?? null;

    if (!hit) {
      // Nothing in the bodies names the vendor — auth-only, or JSON that any
      // appliance might return. The certificate is the remaining evidence.
      if (!(await this.certificateIdentifiesSennheiser(ip))) {
        const authWalled = bodies.length === 0 && hits.some(h => h.kind === 'auth');

        // A host that answers 443 with 401 on every path is not a host that said
        // no. It said "credentials, please" — which is exactly what a
        // password-protected EW-DX says, and RFDeck is holding the passwords for
        // the very devices it is looking for.
        //
        // Rejecting it here on the certificate alone is what left an EW-DX
        // permanently offline after a DHCP move: the row kept polling a dead
        // address, the receiver sat at a new one answering 401, and the
        // reconcile that would have recognised it with a stored password never
        // ran, because the address was discarded before reconcile could see it.
        //
        // So an auth wall is announced as a *candidate* rather than offered as a
        // device. Nothing is claimed and nothing is shown to the operator; a
        // listener may try credentials it already has, and only ever for a device
        // it is currently missing. That keeps the promise this probe chain was
        // tightened for — RFDeck does not present itself to strangers' appliances
        // — because the only extra traffic is to a host already answering on 443,
        // using a password we hold for hardware known to be absent.
        if (authWalled) {
          // Announced on every sweep. Whether it is worth spending credentials on
          // is not decidable here: this class does not know what passwords exist,
          // so it cannot know that they changed — and an operator who has just
          // re-adopted a receiver and typed its new password needs the next sweep
          // to try it, not to be told the address was already settled. The
          // listener dedupes against the passwords themselves.
          log.debug(
            `[Discovery] ${ip} answered 443 with 401 on every path and its certificate ` +
            `does not name Sennheiser — passing it for authenticated identification ` +
            `in case it is a password-protected receiver that has changed address`,
          );
          this.emit('auth-wall', { ip, port: SSC_PORT });
          return;
        }

        const summary = bodies.length > 0
          ? `answered on 443 but the response is not SSC (${JSON.stringify(bodies[0].data).slice(0, 120)})`
          : 'answered on 443 with HTTPS 401 on every path';
        this.settled.set(ip, 'not-sennheiser');
        this.reportNotOffered(
          `http:${ip}`,
          `${ip} ${summary}, and its TLS certificate does not name Sennheiser — ` +
          `not offering it. If this is a receiver, add it by IP; a password-protected ` +
          `unit cannot be identified by an unauthenticated probe.`,
        );
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
    // It is a device after all — any earlier verdict about this address is void.
    this.settled.delete(ip);
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
    // A passive listener can hear from an excluded address without anything
    // having been sent to it. Offering it would put the operator back where
    // they started, so the exclusion is honoured on the way out too.
    if (this.excluded(ip)) return;
    this.seenIps.add(key);
    // Finding a device is the event this whole subsystem exists to produce, and
    // it was logged where a deployed server would never print it.
    log.warn(`[Discovery] Found ${name} at ${ip}:${port} (${protocol})`);
    this.emit('discovered', { ip, port, name, protocol, ...known } as DiscoveredDevice);
  }

  private getLocalIpv4Addresses(): string[] {
    return mcpBus.getActiveInterfaces().map(i => i.address);
  }

  /**
   * Say, once, that a device was found and then not offered.
   *
   * Discovery logged every one of its decisions at `debug`, and a deployed
   * server runs at `warn` — so a receiver that RFDeck saw, examined and
   * rejected produced no output at all. From the outside that is
   * indistinguishable from the device never having been on the network, which
   * is the hardest possible thing to diagnose and cost days of it.
   *
   * Refusing to offer a device the operator can see on their own network is
   * degraded behaviour, so it is a warning. Once per address per run, because
   * the scans repeat and this must not become the noise it is trying to cut
   * through.
   */
  private reportNotOffered(key: string, message: string): void {
    if (this.notOfferedReported.has(key)) return;
    this.notOfferedReported.add(key);
    log.warn(`[Discovery] ${message}`);
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
    // And any "not a Sennheiser device" verdict, so re-adding an address the
    // operator has just corrected does not wait out the cache.
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
