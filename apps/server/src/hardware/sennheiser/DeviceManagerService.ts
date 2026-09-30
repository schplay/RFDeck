import crypto from 'crypto';
import { DiscoveryService, DiscoveredDevice, resolveDiscoveryDisabled, MCP_PORT } from './DiscoveryService';
import { SSCClient } from './SSCClient';
import { G3G4Client } from './G3G4Client';
import { mcpBus } from './McpBus';
import { findIntermodHits, intermodSignature, IntermodReport } from '../intermod';
import { EventEmitter } from 'events';
import { Server } from 'socket.io';
import { Device, Channel } from '@rfdeck/shared-types';
import { prisma } from '../../db';
import { getMacByIp, isDirectlyAttached } from '../../utils/arp';
import {
  evaluateSample, confirmDropout, DEFAULT_RF_THRESHOLDS,
  RfState, RfThresholds,
} from '../rfState';
import {
  addSample, estimate as estimateBattery,
  BatterySample, BatteryEstimate,
} from '../batteryEstimator';
import { decryptSecret } from '../../auth/secretBox';
import { detectFirmwareChange } from '../firmwareChange';
import { isSscModel, isPlaceholderModel, isLegacyMcpModel } from '../deviceRole';
import { ShureClient } from '../shure/ShureClient';
import { Digital6000Client } from './digital6000/Digital6000Client';
import { isDigital6000, SSC_PORT as D6000_PORT } from './digital6000/protocol';
import { canSet } from '../HardwareClient';
import { log } from '../../logger';

// The union is kept rather than replaced by HardwareClient because the
// Sennheiser-specific branches below still narrow on it with `instanceof`.
// What matters for a third vendor is that everything those branches guard is
// optional: a ShureClient falls through them and is driven entirely by the
// shared `state` / `connected` / `disconnected` contract.
type ClientType = SSCClient | G3G4Client | ShureClient | Digital6000Client;

/**
 * How often an SSC client keeps trying while an MCP stand-in is running.
 *
 * Slow, not stopped. A device that turns out to be an EW-DX after all is then
 * still found, and a device that really is a G3 costs one failed request every
 * fifteen seconds instead of four a second.
 */
const SSC_RETRY_WHILE_LEGACY_MS = 15_000;

/**
 * Which of a receiver's addresses are its secondary (Dante) interface.
 *
 * Registering one of these hides that address from discovery permanently, so
 * that an EW-DX's second NIC is not offered as a second device. That is a
 * destructive decision — a hidden address cannot be added, and nothing on
 * screen says why — so it may only be made on evidence.
 *
 * It used to be made on a guess. `danteAll` is every IPv4 string found
 * anywhere in the response, at any depth, under any key: on firmware that does
 * not name its fields `address`/`ip`/`ipv4`, the properly-keyed list came back
 * empty and the code fell back to that scrape. A receiver's own GATEWAY and
 * DNS server were then registered as its "secondary interfaces", and any real
 * device sitting at one of those addresses disappeared from discovery for the
 * life of the process.
 *
 * So: only addresses the device itself labelled as addresses, and never one it
 * also calls a control address. If the firmware names its fields in a way
 * RFDeck does not recognise, nothing is suppressed and the operator sees one
 * extra entry — which is a far smaller problem than a device that cannot be
 * found and gives no reason.
 */
export function secondaryAddresses(
  net: { controlAll: string[]; danteAddrs: string[] },
  connectedIp: string,
): string[] {
  return net.danteAddrs.filter(a =>
    a !== connectedIp &&
    a !== '0.0.0.0' &&
    !a.startsWith('255.') &&
    !a.startsWith('127.') &&
    // A control address is how RFDeck reaches a device. It is never a
    // secondary, whatever else the device reports it as.
    !net.controlAll.includes(a)
  );
}

/**
 * Which unidentified G3/G4 row, if any, a reported name belongs to.
 *
 * Pure and exported, because this is the one place RFDeck adopts a device on
 * evidence weaker than a hardware address, and the bounds on it are the whole
 * safety argument. The caller supplies only rows that have never been identified;
 * a row carrying a stored MAC must never reach here, or a name would override
 * real evidence.
 */
export function chooseByName<T extends { name: string | null; ip: string; port: number }>(
  discoveredName: string | undefined,
  candidates: T[],
  isConnected: (d: T) => boolean,
): { match?: T; reason?: string } {
  const wanted = (discoveredName ?? '').trim().toLowerCase();
  if (!wanted) return { reason: 'the device reported no name' };

  // Discovery invents these when a device has not said what it is called, so
  // every unnamed receiver on the network would otherwise look like one device.
  if (/^sennheiser g[34e]?[\s/]*g?[34]?\s*\(/i.test(wanted) || /^unknown/i.test(wanted)) {
    return { reason: `"${discoveredName}" is a placeholder, not a name anybody set` };
  }

  const byName = candidates.filter(d => (d.name ?? '').trim().toLowerCase() === wanted);
  if (byName.length === 0) return { reason: `no unidentified device is called "${discoveredName}"` };

  const offline = byName.filter(d => !isConnected(d));
  if (offline.length === 0) return { reason: `"${discoveredName}" is already connected at its own address` };
  if (offline.length > 1) {
    return {
      reason: `${offline.length} offline devices are called "${discoveredName}", `
        + 'which is too ambiguous to adopt automatically',
    };
  }
  return { match: offline[0] };
}

/**
 * Whether the name fallback should run, and whether a MAC should be recorded.
 *
 * Two lines of logic, pulled out because both of them have been wrong in ways
 * that could not be seen from the outside, and because `tryAutoReconcile` needs a
 * database to reach and so was never covered.
 *
 * The rule that matters: **a readable MAC is not a precondition for matching by
 * name.** The neighbour table only holds directly-attached addresses. For an
 * off-link device the kernel resolves the next hop instead, so `ip neigh show`
 * prints nothing and no MAC for that device will ever be readable from this host.
 * A rig with control on one subnet and receivers on another — an ordinary layout —
 * therefore produced a single symptom for every receiver, forever: "found at <ip>
 * but could not be matched to any offline device", with the correct name sitting
 * in the alert text. The name is the only identity a routed G3/G4 has.
 *
 * The MAC is an optimisation: recorded when it is there, so the weaker evidence is
 * needed at most once per device; simply absent when it is not.
 */
export function identityPlan(
  storedMatch: unknown | null,
  macReadable: boolean,
): { matchByName: boolean; recordMac: boolean } {
  return {
    // Stored evidence wins and needs no name; otherwise try the name, MAC or not.
    matchByName: !storedMatch,
    recordMac: macReadable,
  };
}

export class DeviceManagerService extends EventEmitter {
  private discovery: DiscoveryService;
  private io: Server;
  private clients: Map<string, ClientType> = new Map();
  private channelCache: Map<string, Channel> = new Map();
  // ip:port → the inventory row that address belongs to.
  //
  // The row id is RFDeck's own uuid: it is assigned when the device is added
  // and never changes, for any reason. "ip:port" is merely where the device
  // answers today. Everything that has to outlive a power cycle keys on the
  // row id; only live routing keys on the address.
  private deviceRowIds: Map<string, string> = new Map();
  // Channels whose persisted records have already been checked for keys left
  // over from when a channel was identified by its name.
  private keysMigrated: Set<string> = new Set();
  // Addresses already reported as found-but-withheld, so repeating scans do
  // not repeat the warning.
  private suppressionReported: Set<string> = new Set();
  // The intermod picture, and the frequency set it was computed from.
  private intermod: IntermodReport = { hits: [], truncated: false, sourceCount: 0 };
  private intermodSig = '';
  private deviceNames: Map<string, string> = new Map(); // base id → user-assigned name
  // base id → what the device is for. An IEM transmitter has no RF and no
  // transmitter battery, and alerting on their absence is how a working
  // monitor rig raises a dropout every few seconds all night.
  private deviceRoles: Map<string, 'mic' | 'iem'> = new Map();
  // base id -> receiver slots the operator has marked as not in use.
  //
  // A four-channel receiver with two radios on it is the normal case, and
  // `active` could only speak for the whole box: the empty slots reported a
  // permanently disconnected channel, and silencing them meant deactivating
  // the receiver that was carrying the working mics.
  private disabledSlots: Map<string, Set<number>> = new Map();
  // Devices that have successfully connected over SSCv2 at least once.
  //
  // The model string is a weak signal — a device added without one is stored
  // as "Sennheiser Device", which names nothing — so the strongest evidence
  // that something speaks SSC is that it already has. Deliberately NOT cleared
  // on untrack: standing down and going live again must not reopen the window
  // in which a transient disconnect could downgrade a proven SSC receiver to
  // MCP.
  private sscProven = new Set<string>();
  private discoveredCache: Map<string, any> = new Map(); // key → discovered device payload
  // IPs that have had at least one successful connection — used to distinguish
  // a real "went offline" from an initial SSCv2 probe failure before G3/G4 fallback.
  private genuinelyOnlineIps = new Set<string>();
  // Pending device:lost timers — cancelled if the device reconnects within the grace period.
  // This prevents brief SSE drops / network hiccups from causing visible offline flashes.
  private lostTimers = new Map<string, NodeJS.Timeout>();
  // Devices whose loss was announced, so the return can be announced too.
  private lostIps = new Set<string>();
  // Scans on a cadence while any tracked device is unreachable. See start().
  /** Last reported unreachable set, so the warning repeats only when it changes. */
  private lastUnreachableSignature = '';
  private recoveryTimer: NodeJS.Timeout | null = null;
  // Recent disconnect timestamps per ip. A device that reconnects inside the
  // loss debounce never reaches the event log, so rapid churn was invisible —
  // exactly the failure an operator watching a flapping card needs named.
  private disconnectTimes = new Map<string, number[]>();
  private unstableAlertedAt = new Map<string, number>();
  // Unmatched-discovery alerts already raised, so one orphan does not repeat
  // into the event log on every scan.
  private orphanAlerted = new Set<string>();
  /**
   * How many times an address has been seen and not matched to a row.
   *
   * The first sighting is not evidence of anything. A receiver found by its reply
   * to a broadcast probe has no neighbour entry yet, so its hardware address is
   * unreadable on that pass and becomes readable on a later one — RFDeck now
   * causes that rather than waiting for it (see `resolveHardwareAddress`), but the
   * ordering is still a race it does not control.
   *
   * Alerting on the first pass told the operator that eleven receivers could not
   * be matched and that they should correct each address by hand, and then every
   * one of them synced on its own a few minutes later. An alert that is retracted
   * by events is worse than no alert: it spends the operator's trust on work that
   * did not need doing. So the claim waits for a second sighting, by which point
   * RFDeck has definitely sent to the address and a readable entry should exist.
   */
  private orphanSightings = new Map<string, number>();
  // Low-battery readings awaiting a second consecutive sample. One reading is
  // not evidence: transmitters report garbage during a re-sync, and a single
  // bad sample used to raise a CRITICAL alert on a full pack.
  private pendingLowBattery = new Map<string, number>();

  // Last moment each device was known to be in contact, keyed by device id.
  //
  // Distinct from "last telemetry": a receiver whose values have not changed
  // sends nothing, and that silence must not read as a frozen feed. Clients use
  // this, broadcast as a heartbeat, to decide what is stale.
  private lastSeen = new Map<string, number>();

  // Devices that are reachable but refused the stored password, with the
  // reason. Reachable-but-refused looks identical to healthy from the outside
  // — the device is "online" — while no channel will ever appear. Tracked so
  // it can be shown, and replayed to a client that connects later.
  private authFailed = new Map<string, string>();
  private readonly LOST_DEBOUNCE_MS = 2000;
  // Debounce: avoid triggering multiple scans in quick succession when several
  // devices drop at once (e.g. network switch reboot).
  private lastAutoScanAt = 0;
  private readonly AUTO_SCAN_COOLDOWN_MS = 20_000;
  /** How long to wait before the next automatic sweep. Grows while nothing changes. */
  private autoScanGapMs = 20_000;
  /**
   * Slowest the automatic sweep ever gets.
   *
   * Two minutes, not five. The backoff exists so a rig switched off for the
   * weekend is not scanned for four times a minute, but it also sets how long an
   * operator waits after powering the rig back on — and nobody powers up a rack
   * and expects to wait five minutes to see it. Two is quiet enough to be
   * invisible on the network and short enough to feel automatic.
   */
  private readonly AUTO_SCAN_GAP_MAX_MS = 2 * 60_000;
  // RF dropout alert debounce: EW-DX diversity switching can report 0% then 100%
  // within the same second. Only alert when the signal stays low for the confirm
  // window, and don't re-alert the same channel more than once a minute.
  private pendingDropouts = new Map<string, NodeJS.Timeout>();
  private lastDropoutAlertAt = new Map<string, number>();
  private readonly DROPOUT_REALERT_MS = 60_000;
  // Hysteresis band and confirmation window — see hardware/rfState.ts.
  private rfThresholds: RfThresholds = { ...DEFAULT_RF_THRESHOLDS };
  // channelId → current RF state. Server-side so every client agrees.
  private rfStates = new Map<string, RfState>();
  // channelId → recent battery readings, for runtime projection. Computed on
  // the server so every client shows the same estimate.
  private batteryHistory = new Map<string, BatterySample[]>();
  private batteryEstimates = new Map<string, BatteryEstimate>();
  // Battery moves slowly; sampling every reading would be pure noise.
  private lastBatterySampleAt = new Map<string, number>();
  private readonly BATTERY_SAMPLE_INTERVAL_MS = 30_000;
  // Recent RF events, replayed to clients that connect mid-show. Capped —
  // a long run would otherwise grow this without bound.
  private rfEventLog: any[] = [];
  private readonly RF_EVENT_LOG_MAX = 500;
  // Secondary (e.g. Dante) IPs of tracked devices, learned by asking each
  // connected SSC device for its own network config.  Discovery hits on these
  // IPs are suppressed instead of shown as phantom devices.
  // Maps secondary IP → control IP of the owning device.
  private secondaryIps = new Map<string, string>();

  constructor(io: Server) {
    super();
    this.io = io;
    this.discovery = new DiscoveryService(resolveDiscoveryDisabled());

    this.discovery.on('discovered', (device: DiscoveredDevice) => {
      this.handleDiscovered(device);
    });

    // A host behind an auth wall: something is on 443 that wants credentials and
    // could not be identified without them. `tryAutoReconcile` already knows how
    // to settle that — it tries each password the inventory holds and matches the
    // answer by serial or MAC — so the only thing that was missing was being told
    // the address existed.
    this.discovery.on('auth-wall', ({ ip, port }: { ip: string; port: number }) => {
      // Only when something is actually missing.
      //
      // Presenting stored credentials to a stranger's appliance is the thing the
      // probe chain was tightened to stop, so this asks first whether RFDeck is
      // even looking for anything. With every tracked device reachable there is
      // nothing this address could be, and nothing is sent.
      const missing = [...this.clients.entries()].some(([key, client]) => {
        if (key.endsWith('-legacy')) return false;
        if (!key.endsWith(':443')) return false;   // an SSC row is what this could be
        return !client.isConnected && !this.clients.get(`${key}-legacy`)?.isConnected;
      });
      if (!missing) {
        log.debug(`[DeviceManager] ${ip} wants credentials, but no SSC device is missing — leaving it alone`);
        return;
      }
      void this.tryCredentialsOnce(ip, port);
    });

    // After every scan, re-attempt reconciliation for devices that were discovered
    // but never matched to inventory.  Without this, a failed first reconcile
    // (e.g. ARP race) leaves the IP in seenIps and it is never retried — the
    // device stays "discovered" forever while its inventory entry stays offline.
    this.discovery.on('scan:complete', () => {
      this.reconcileUntrackedDiscoveries().catch(() => {});
    });
  }

  /**
   * Read the interface chosen in Settings and put it into effect.
   *
   * Called at startup and again whenever the setting is saved, so choosing an
   * interface takes effect on the next scan rather than at the next restart —
   * an operator changing it is usually doing so because discovery is not
   * finding something right now.
   */
  async applyBindInterface(): Promise<void> {
    try {
      const settings = await prisma.settings.findFirst();
      mcpBus.setBindAddress(settings?.bindInterface);
    } catch (err: any) {
      log.warn(`[DeviceManager] Could not read the network interface setting: ${err?.message}`);
    }
  }

  /**
   * Re-read the operator's discovery exclusion list and hand it to discovery.
   *
   * Called at startup and again whenever the setting is saved.
   */
  async applyDiscoveryIgnore(): Promise<void> {
    try {
      const settings = await prisma.settings.findFirst();
      this.discovery.setIgnoreList(settings?.discoveryIgnore);
    } catch (err: any) {
      log.warn(`[DeviceManager] Could not read the discovery exclusion list: ${err?.message}`);
    }
  }

  /** Re-read the interface setting and restart the passive listeners on it. */
  async rebindNetworkInterface(): Promise<void> {
    const before = mcpBus.getBindAddress();
    await this.applyBindInterface();
    if (mcpBus.getBindAddress() === before) return;
    // The mDNS browsers and the Shure listener are bound per interface, so they
    // have to be rebuilt rather than reconfigured.
    this.discovery.stop();
    this.discovery.start();
    log.info('[DeviceManager] Discovery restarted on the newly selected interface');
    this.discovery.scan().catch(() => {});
  }

  private async reconcileUntrackedDiscoveries(): Promise<void> {
    for (const device of this.discoveredCache.values()) {
      const id = `${device.ip}:${device.port}`;
      if (this.clients.has(id) || this.clients.has(`${id}-legacy`)) continue;
      await this.tryAutoReconcile(device.ip, device.port, device.name).catch(() => {});
    }
  }

  async start() {
    // Apply the operator's interface choice before anything binds or scans,
    // and the exclusion list before a single packet could be sent.
    await this.applyBindInterface();
    await this.applyDiscoveryIgnore();

    // Fix legacy G3/G4 records added via discovery before manufacturer inference was corrected.
    // MCP-discovered devices have port 53212; records with manufacturer='Unknown' got that value
    // because the old heuristic couldn't match a channel label like "Vocal 1".
    await prisma.inventoryDevice.updateMany({
      where: { port: 53212, manufacturer: 'Unknown' },
      data:  { manufacturer: 'Sennheiser', model: 'EW G3/G4' },
    });

    // Load inventory from DB on startup and begin tracking.
    // Devices the operator marked inactive are intentionally powered off — don't
    // track them, so they raise no dropout alerts and show no dashboard cards.
    const inventory = await prisma.inventoryDevice.findMany();
    for (const dev of inventory) {
      if (dev.active === false) {
        log.debug(`[DeviceManager] Skipping inactive device "${dev.name}" (${dev.ip})`);
        continue;
      }
      this.trackDevice(dev);
    }

    // Prune the persisted event log on startup. Without this a resident
    // install grows without bound — at 128 channels a busy show can produce a
    // lot of rows.
    this.pruneEvents().catch(() => {});

    this.discovery.start();
    // Trigger startup scans to find devices that may have changed IP after a power cycle
    // or DHCP reassignment. Three passes cover already-booted devices, slow-booting devices,
    // and devices that finish booting after the second scan.
    const startupScan = () => { void this.scanForMissingDevices(); };
    setTimeout(startupScan, 2_000);
    setTimeout(startupScan, 30_000);
    setTimeout(startupScan, 75_000);

    // Recovery is not an event, it is a state: as long as any active device is
    // unreachable, keep scanning until it is found. A fixed burst of retries
    // assumed the device would be back within a couple of minutes; a rack
    // that comes up slowly, or a device re-enabled long after it moved,
    // outlived the burst and then nothing ever looked for it again. RFDeck
    // runs unattended — a tracked device must never need a human to find it.
    this.recoveryTimer = setInterval(() => {
      const down: string[] = [];
      for (const [key, client] of this.clients) {
        if (key.endsWith('-legacy')) continue; // counted via its base entry
        const legacy = this.clients.get(`${key}-legacy`);
        if (!client.isConnected && !(legacy?.isConnected)) {
          // The client class is the single most useful fact here: an EW-DX on a
          // G3G4Client can never connect however long it is given, and that is
          // invisible from the outside — the device is in the discovery list,
          // the row says offline, and nothing says why.
          down.push(
            `${this.deviceNames.get(key) ?? key} at ${key} on ${client.constructor.name}` +
            (legacy ? ` (+${legacy.constructor.name} standing in)` : ''),
          );
        }
      }

      if (down.length > 0) {
        // Two datagrams, every time round.
        //
        // A broadcast reaches every G3/G4 on the segment, which is the whole job
        // when a receiver has just been switched on. This used to be carried by
        // the full scan — which also walks every address on the network for
        // EW-DX, minutes on a /16 — so a device powered on had to wait for that
        // sweep to finish and for the backoff gap on top. Ten minutes in
        // practice, with nothing on screen to say RFDeck was even looking.
        //
        // The expensive unicast sweep stays on the slow cadence, for the case
        // broadcast cannot reach. This is the case that actually happens.
        this.discovery.broadcastMcpProbe();

        // Said at `warn`, and only when the set changes.
        //
        // A deployed server runs at LOG_LEVEL=warn, so this was `debug` and
        // therefore invisible on every real install — which is why "some devices
        // are always offline" went weeks without anything to go on. A device
        // RFDeck is tracking and cannot reach is the product's most common
        // operational fault, and it must never be silent.
        const signature = down.join('|');
        if (signature !== this.lastUnreachableSignature) {
          this.lastUnreachableSignature = signature;
          const lines = [
            `[DeviceManager] ${down.length} tracked device(s) unreachable:`,
            ...down.map(d => `  ${d}`),
            '  If one of these is in the discovery list at a different address, its row '
            + 'has not been re-linked; if the client class above cannot speak that '
            + "device's protocol, the row's port or model is what chose it.",
          ];
          log.warn(lines.join('\n'));
        }
        this.maybeAutoScan();
      } else if (this.lastUnreachableSignature !== '') {
        this.lastUnreachableSignature = '';
        this.resetAutoScanGap();
        log.warn('[DeviceManager] All tracked devices are reachable again');
      }
      // Twenty seconds, not sixty.
      //
      // The work here is now two datagrams and a walk over the client map, so
      // the interval can be set by how long an operator should wait rather than
      // by what the network can stand. Nobody powers up a rack and expects to
      // wait a minute to see it, let alone ten.
    }, 20_000);
  }

  stop() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.discovery.stop();
    for (const client of this.clients.values()) {
      client.stopPolling();
    }
  }

  // Called via REST API when user adds a device
  public trackDevice(
    device: {
      id?: string;
      ip: string; port: number; name?: string;
      manufacturer?: string; model?: string; deviceType?: string;
      disabledSlots?: string | null;
    },
  ) {
    const id = `${device.ip}:${device.port}`;
    // Callers pass the inventory row, so this is present in practice. It is
    // what every durable record about this device's channels is keyed on.
    if (device.id) this.deviceRowIds.set(id, device.id);
    log.debug(`[DeviceManager] trackDevice called for ${device.name ?? id} at ${id}`);
    if (this.clients.has(id)) {
      log.debug(`[DeviceManager] Already tracking ${id}, skipping`);
      return;
    }

    // Store user-assigned name for use in channel labels
    if (device.name) this.deviceNames.set(id, device.name);
    // And what it is for. 'output' is the inventory's word for an IEM
    // transmitter; everything else carries a microphone.
    this.deviceRoles.set(id, device.deviceType === 'output' ? 'iem' : 'mic');
    // Slots the operator has said are empty. Read before the first poll, so a
    // disabled slot never produces a card even momentarily.
    this.disabledSlots.set(id, DeviceManagerService.parseSlots((device as any).disabledSlots));

    // Shure speaks a different protocol on a different port, and there is no
    // probe chain to fall into: the manufacturer on the inventory row decides.
    //
    // Sennheiser keeps the behaviour it had — try SSCv2, fall back to G3/G4 on
    // failure — because that fallback is how a G3 is recognised at all, and it
    // is a Sennheiser-internal detail rather than something a second vendor
    // should be dragged through.
    // Digital 6000 is Sennheiser, but not the Sennheiser SSCClient speaks.
    // "The SSC Server implemented for Digital 6000 devices supports only
    // UDP/IP" — there is no HTTPS interface for the probe chain to find, so an
    // EM 6000 added before this existed would probe, fail, fall through to the
    // G3/G4 fallback, fail that too, and sit offline. Chosen by model because
    // that is the only thing that distinguishes it from an EW-DX before either
    // has answered.
    if (isDigital6000(device.model ?? '')) {
      const d6000 = new Digital6000Client(device.ip, D6000_PORT);
      this.setupClientListeners(d6000, device.ip, device.port, id);
      this.clients.set(id, d6000);
      d6000.startPolling();
      return;
    }

    // G3/G4 speak MCP and nothing else. There is no HTTPS interface on them
    // for the probe chain to find, so starting an SSC client is a guaranteed
    // five-URL timeout chain before the first `disconnected` fires and the MCP
    // client it needed all along is put in its place. Paid once per G3 at
    // startup, with every other receiver probing at the same time, that is
    // what made a resync take minutes — and a G3 whose SSC client happened to
    // be told it was an SSC model never got the fallback at all.
    //
    // Two signals, either of which is conclusive: the port (MCP devices are
    // stored on 53212, which is how discovery found them) and a model that
    // names the generation.
    if (device.port === MCP_PORT || isLegacyMcpModel(device.model)) {
      // `info`, not `debug`: this decision is irreversible for the life of the
      // client and is exactly what makes an EW-DX unreachable if it is wrong.
      log.info(
        `[DeviceManager] ${device.ip} is a G3/G4 (${device.port === MCP_PORT ? `port ${MCP_PORT}` : `model "${device.model}"`}) ` +
        `— starting on MCP without probing for SSC`,
      );
      const legacy = new G3G4Client(device.ip, device.port);
      this.setupClientListeners(legacy, device.ip, device.port, id);
      this.clients.set(id, legacy);
      legacy.startPolling();
      return;
    }

    if (/shure/i.test(device.manufacturer ?? '')) {
      const shure = new ShureClient(device.ip, device.port, device.model ?? '');
      this.setupClientListeners(shure, device.ip, device.port, id);
      this.clients.set(id, shure);
      shure.startPolling();
      return;
    }

    // First try SSCv2 (HTTPS), passing password if one is stored.
    // Passwords are encrypted at rest and only decrypted here, in memory.
    const client = new SSCClient(
      device.ip,
      device.port,
      decryptSecret((device as any).password ?? null),
    );
    this.setupClientListeners(client, device.ip, device.port, id);

    // Proof beats inference: once this device has answered as SSCv2, no
    // disconnect may hand it to a client that cannot speak to it.
    client.on('connected', () => {
      this.sscProven.add(id);

      // It speaks SSC after all, so retire the MCP stand-in if one was started.
      // Without this the fallback stayed forever even once the device proved
      // the fallback was unnecessary.
      const legacy = this.clients.get(`${id}-legacy`);
      if (legacy) {
        legacy.stopPolling();
        this.clients.delete(`${id}-legacy`);
        this.clearChannelsForDevice(`${id}-legacy`);
        log.info(
          `[DeviceManager] ${device.ip} answered as SSCv2 — dropping the G3/G4 ` +
          `client that was standing in for it`,
        );
      }
    });

    client.on('disconnected', () => {
      // The SSCv2 -> G3/G4 fallback is a one-way door: it stops the SSC client
      // and starts an MCP one in its place. That is how a G3 is recognised at
      // all, and it is exactly wrong for an EW-DX, which does not speak MCP.
      //
      // A single transient disconnect — a slow TLS handshake, a device still
      // booting, every receiver being probed at once when the rig goes live —
      // was enough to walk an EW-DX through that door and leave it on a client
      // that could never reach it. Going live again just re-ran the race, so
      // the symptom was a receiver that never came back while the G3s did.
      //
      // A device the inventory already names as an SSC receiver never takes
      // the fallback. It keeps retrying as what it is.
      if (isSscModel(device.model) || this.sscProven.has(id)) {
        const why = this.sscProven.has(id)
          ? 'it has already connected as SSCv2'
          : `model "${device.model}" is an SSC device, not G3/G4`;
        log.debug(`[DeviceManager] ${device.ip} disconnected; keeping SSC client (${why})`);
        return;
      }

      if (!this.clients.get(`${id}-legacy`)) {
        // Slow the SSC client down; do NOT stop it.
        //
        // Stopping it was the one-way door. SSCClient polls on an interval and
        // recovers on its own — it never gives up — so stopping it threw away
        // the only thing that could bring an EW-DX back, and the MCP client
        // put in its place can never reach one. The original reason was log
        // noise from probing a G3 that will never answer on 443, and slowing
        // the retry solves that without the door.
        const ssc = this.clients.get(id);
        if (ssc instanceof SSCClient) {
          ssc.stopPolling();
          ssc.startPolling(SSC_RETRY_WHILE_LEGACY_MS);
        }
        log.info(
          `[DeviceManager] ${device.ip} did not answer as SSCv2 — trying G3/G4 MCP. ` +
          `SSC keeps retrying every ${SSC_RETRY_WHILE_LEGACY_MS / 1000}s in case it is one.`,
        );
        const legacyClient = new G3G4Client(device.ip, device.port);
        this.clients.set(`${id}-legacy`, legacyClient);
        this.setupClientListeners(legacyClient, device.ip, device.port, `${id}-legacy`);
        legacyClient.startPolling();
      }
    });

    this.clients.set(id, client);
    client.startPolling(250);
  }

  // manufacturer and model are carried through, not merely tolerated: they are
  // what trackDevice uses to decide which protocol to speak. Callers pass the
  // whole inventory row, so they are present at runtime either way — declaring
  // them stops a future caller building a literal here and silently turning a
  // Shure receiver back into a Sennheiser one.
  public updateTrackedDevice(
    device: {
      ip: string; port: number; active?: boolean;
      name?: string; manufacturer?: string; model?: string; deviceType?: string;
      disabledSlots?: string | null;
    },
  ) {
    this.untrackDevice(device.ip, device.port);
    if (device.active === false) return; // inactive devices are never tracked
    this.trackDevice(device);
  }

  // Operator marked a device active/inactive.  Inactive devices are fully
  // untracked: no polling, no telemetry, no dropout or battery alerts, and their
  // channel strips are removed from the dashboard.
  public setDeviceActive(
    device: {
      ip: string; port: number; name?: string; password?: string | null;
      manufacturer?: string; model?: string; deviceType?: string;
      disabledSlots?: string | null;
    },
    active: boolean,
  ) {
    const id = `${device.ip}:${device.port}`;
    if (active) {
      log.info(`[DeviceManager] Activating "${device.name ?? id}" — resuming tracking`);
      this.trackDevice(device);
      // Look for it now, at the address it is at rather than the one on file.
      //
      // Re-enabling only started a client aimed at the recorded address, so an
      // operator whose receiver had moved could toggle a device off and on and
      // watch nothing happen — the one manual step they would obviously reach
      // for, doing nothing. Enabling a device is a statement that it is supposed
      // to be there, which is exactly when it is worth sweeping for it.
      this.resetAutoScanGap();
      this.lastAutoScanAt = 0;
      this.maybeAutoScan();
    } else {
      log.info(`[DeviceManager] Deactivating "${device.name ?? id}" — stopping tracking`);
      // Cancel any pending dropout timers for this device's channels so a
      // deactivation mid-dropout can't fire an alert after the fact.
      const prefix = this.channelIdPrefix(id);
      for (const [channelId, timer] of this.pendingDropouts) {
        if (channelId.startsWith(prefix)) {
          clearTimeout(timer);
          this.pendingDropouts.delete(channelId);
        }
      }
      this.untrackDevice(device.ip, device.port);
    }
  }

  /**
   * Which receiver slots on this device are not in use.
   *
   * Stored on the inventory row as a comma-separated list, so it survives a
   * restart and is the same for every client.
   */
  private static parseSlots(spec?: string | null): Set<number> {
    const out = new Set<number>();
    for (const part of (spec ?? '').split(',')) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n > 0) out.add(n);
    }
    return out;
  }

  /** Is this receiver slot one the operator has marked as not in use? */
  private slotDisabled(deviceId: string, slot: number): boolean {
    const baseId = deviceId.replace(/-legacy$/, '');
    return this.disabledSlots.get(baseId)?.has(slot) ?? false;
  }

  /**
   * Operator marked some of a receiver's slots as not in use.
   *
   * Takes effect at once rather than at the next restart: the reason anyone
   * touches this is a card on the dashboard that is red and should not be.
   * Channels for newly disabled slots are dropped from the cache and from
   * every client, along with any alerting state they had accumulated.
   */
  public setDisabledSlots(device: { ip: string; port: number }, spec: string | null | undefined) {
    const id = `${device.ip}:${device.port}`;
    const next = DeviceManagerService.parseSlots(spec);
    this.disabledSlots.set(id, next);

    for (const slot of next) {
      // Both the live client and the G3/G4 stand-in file channels under their
      // own device id, so both have to be cleared.
      for (const owner of [id, `${id}-legacy`]) {
        const channelId = this.stableChannelId(owner, slot);
        if (!this.channelCache.delete(channelId)) continue;
        this.rfStates.delete(channelId);
        const pending = this.pendingDropouts.get(channelId);
        if (pending) { clearTimeout(pending); this.pendingDropouts.delete(channelId); }
        this.pendingLowBattery.delete(channelId);
        this.batteryHistory.delete(channelId);
        this.batteryEstimates.delete(channelId);
        this.lastBatterySampleAt.delete(channelId);
        this.io.emit('channel:removed', { channelId });
      }
    }
    this.refreshIntermod();
    log.info(
      `[DeviceManager] ${id}: slot(s) ${next.size ? [...next].sort().join(', ') : 'none'} marked not in use`,
    );
  }

  public untrackDevice(ip: string, port: number) {
    const id = `${ip}:${port}`;
    this.deviceRoles.delete(id);
    this.disabledSlots.delete(id);
    const client = this.clients.get(id);
    if (client) {
      client.stopPolling();
      this.clients.delete(id);
    }
    const legacy = this.clients.get(`${id}-legacy`);
    if (legacy) {
      legacy.stopPolling();
      this.clients.delete(`${id}-legacy`);
    }
    // Clear server-side channel cache so the snapshot doesn't replay stale channels
    this.clearChannelsForDevice(id);
    // Drop RF state and any pending dropout timers for this device — a device
    // we stop tracking must not fire an alert after the fact.
    const prefix = this.channelIdPrefix(id);
    for (const key of [...this.rfStates.keys()]) {
      if (key.startsWith(prefix)) this.rfStates.delete(key);
    }
    for (const [key, timer] of this.pendingDropouts) {
      if (key.startsWith(prefix)) { clearTimeout(timer); this.pendingDropouts.delete(key); }
    }
    // Discard battery history — a device that comes back after being off has a
    // discontinuous curve, and projecting across the gap would be wrong.
    for (const key of [...this.batteryHistory.keys()]) {
      if (key.startsWith(prefix)) {
        this.batteryHistory.delete(key);
        this.batteryEstimates.delete(key);
        this.lastBatterySampleAt.delete(key);
      }
    }
    this.genuinelyOnlineIps.delete(ip);
    this.orphanAlerted.delete(ip);
    this.orphanSightings.delete(ip);
    // A fresh client will re-evaluate the password; do not carry the verdict.
    if (this.authFailed.delete(id)) {
      this.io.emit('device:auth', { ip, port, failed: false, reason: null });
    }
    const pendingLost = this.lostTimers.get(ip);
    if (pendingLost) { clearTimeout(pendingLost); this.lostTimers.delete(ip); }
    // Allow the device to be re-discovered (clears seenIps in DiscoveryService)
    this.discovery.forgetDevice(ip, port);
    this.discovery.forgetDevice(ip, MCP_PORT); // also clear MCP port for G3/G4 devices
    // Release any secondary (Dante) IPs owned by this device
    for (const [sIp, owner] of this.secondaryIps) {
      if (owner === ip) this.secondaryIps.delete(sIp);
    }
    // Tell the frontend to remove channel strips for this device
    this.io.emit('device:untracked', { ip, port });
  }

  private setupClientListeners(client: ClientType, ip: string, port: number, id: string) {
    client.on('state', (stateTree: any) => {
      this.lastSeen.set(id, Date.now());

      this.normalizeAndEmit(id, stateTree);
    });

    // Contact without data — the SSC client reports this when the stream is
    // quiet but the device answers a direct probe, or when bytes arrive that
    // are not telemetry. G3/G4 polls at a fixed rate, so 'state' covers it.
    client.on('alive', () => {
      this.lastSeen.set(id, Date.now());
    });

    // Reachable, but the subscription that carries channel data was refused.
    // Broadcast it: this is the state an operator otherwise discovers only by
    // noticing that a connected device has no cards, and then reading logs.
    client.on('auth-failed', ({ reason }: { reason: string }) => {
      if (this.authFailed.get(id) === reason) return;
      this.authFailed.set(id, reason);
      log.warn(`[DeviceManager] ${ip} connected but refused the subscription — ${reason}`);
      this.io.emit('device:auth', { ip, port, failed: true, reason });
    });

    client.on('auth-ok', () => {
      if (!this.authFailed.delete(id)) return;
      log.info(`[DeviceManager] ${ip} accepted the password — subscription restored`);
      this.io.emit('device:auth', { ip, port, failed: false, reason: null });
    });

    client.on('connected', async () => {
      this.lastSeen.set(id, Date.now());
      // A device came back: the picture is moving, so drop back to looking often.
      this.resetAutoScanGap();
      log.info(`[DeviceManager] Connected to ${ip} via ${client instanceof SSCClient ? 'SSCv2' : 'G3/G4'}`);
      // Cancel any pending lost timer — device reconnected within the grace period
      const pendingLost = this.lostTimers.get(ip);
      if (pendingLost) {
        clearTimeout(pendingLost);
        this.lostTimers.delete(ip);
      }
      this.genuinelyOnlineIps.add(ip);
      this.emit('device:online', { ip, port });

      // A return after an announced loss goes in the event log too, so the
      // record shows the outage's length rather than only its start.
      if (this.lostIps.delete(ip)) {
        this.emitAlert({
          severity: 'INFO',
          type: 'DEVICE_ONLINE',
          message: `"${this.deviceNames.get(id) ?? ip}" is back online`,
          deviceId: id,
          deviceName: this.deviceNames.get(id),
        });
      }

      // Ask connected SSC devices for their own network config so we can
      // suppress their secondary (Dante) IPs from discovery.
      if (client instanceof SSCClient) {
        this.registerSecondaryIps(client, ip, port).catch(() => {});
      }

      // For G3/G4 (MCP) devices the API doesn't provide a MAC, so we read
      // the OS ARP cache which is populated as soon as UDP packets are exchanged.
      if (client instanceof G3G4Client) {
        const mac = await getMacByIp(ip);
        if (mac) {
          // Store the MAC on the inventory row so future lookups work.
          //
          // This is the only thing that ever gives a G3/G4 row an identity, so
          // whether it happened is worth saying rather than inferring. A device
          // that has connected many times and still has no MAC means this lookup
          // is failing, which is a fault here and not something about the device.
          const { count } = await prisma.inventoryDevice.updateMany({
            where: { ip, mac: null },
            data: { mac },
          });
          if (count > 0) {
            log.info(`[DeviceManager] Recorded MAC ${mac} for the device at ${ip} — it can now be recognised wherever it moves`);
          }
          await this.reconcileByMac(mac, ip, port);
        } else {
          log.warn(
            `[DeviceManager] Connected to the G3/G4 at ${ip} but could not read its MAC ` +
            `from the neighbour table. Without one this device cannot be recognised if its ` +
            `address changes, so this is worth fixing rather than living with.`,
          );
        }
      }
    });

    client.on('disconnected', (err: any) => {
      log.info(`[DeviceManager] Disconnected from ${ip} — ${err}`);

      // Three losses in five minutes is churn, not an outage. Each one may
      // reconnect inside the debounce and never reach the event log on its
      // own, so the pattern is reported explicitly — with the reason, since
      // that is what identifies the cause.
      const now = Date.now();
      const recent = (this.disconnectTimes.get(ip) ?? []).filter(t => now - t < 300_000);
      recent.push(now);
      this.disconnectTimes.set(ip, recent);
      if (recent.length >= 3 && now - (this.unstableAlertedAt.get(ip) ?? 0) > 600_000) {
        this.unstableAlertedAt.set(ip, now);
        this.emitAlert({
          severity: 'WARNING',
          type: 'DEVICE_UNSTABLE',
          message: `"${this.deviceNames.get(id) ?? ip}" has lost its connection ${recent.length} times in five minutes`,
          detail: `Latest reason: ${String(err ?? 'no reply')}`,
          deviceId: id,
          deviceName: this.deviceNames.get(id),
        });
      }

      this.clearChannelsForDevice(id);
      // Only notify the frontend when a device that was genuinely connected goes offline.
      // Debounced: if the device reconnects within LOST_DEBOUNCE_MS the timer is cancelled
      // so brief SSE drops / network hiccups don't cause a visible offline flash.
      if (this.genuinelyOnlineIps.delete(ip)) {
        // Clear discovery state so the next scan can find the device at its new IP
        // if DHCP assigned a different address after the power cycle.
        this.discovery.forgetDevice(ip, port);
        this.discovery.forgetDevice(ip, 53212);
        const timer = setTimeout(() => {
          this.lostTimers.delete(ip);
          this.emit('device:lost', { ip, port });
          // Into the event log, not only the journal: an operator watching a
          // card flap needs the cause where they are looking.
          this.lostIps.add(ip);
          this.emitAlert({
            severity: 'WARNING',
            type: 'DEVICE_LOST',
            message: `"${this.deviceNames.get(id) ?? ip}" stopped responding`,
            detail: String(err ?? 'no reply'),
            deviceId: id,
            deviceName: this.deviceNames.get(id),
          });
          this.maybeAutoScan();
        }, this.LOST_DEBOUNCE_MS);
        this.lostTimers.set(ip, timer);
      } else {
        // Never connected since (re)tracking: a re-enabled or freshly added
        // device whose recorded IP has gone stale over a power cycle. Nothing
        // else will ever look for it — device:lost fires only for devices
        // that were online first, and G3/G4 discovery is scan-driven, with no
        // mDNS announcement to fall back on the way SSC devices have. So the
        // disable → power off → power on → enable workflow left G3 units
        // unreachable indefinitely. Scan now, and again while the hardware
        // may still be booting.
        log.warn(`[DeviceManager] ${ip} unreachable at its recorded address — scanning until it is found`);
        this.maybeAutoScan();
      }
    });

    // Device identity: persist it, forward it, and reconcile an IP change by MAC.
    //
    // Subscribed for every client rather than only SSCv2. The handler already
    // acts per field, so a vendor that reports less simply triggers less — and
    // gating on the class meant a Shure receiver's firmware was never recorded
    // and never appeared in its maintenance log, silently, because ShureClient
    // emits this event perfectly well and nobody was listening. G3/G4 never
    // emits it at all, so nothing changes there.
    {
      client.on('metadata', async (meta: any) => {
        // Persist identity fields so they survive server restarts
        const patch: Record<string, unknown> = {};
        if (meta.mac)      patch.mac      = meta.mac;
        if (meta.serial)   patch.serial   = meta.serial;
        if (meta.firmware) patch.firmware = meta.firmware;

        // Coordination inputs the hardware knows about itself. A reported
        // band replaces a declared one — the receiver is the truth about
        // its own band — and is the only thing that does.
        if (typeof meta.band === 'string' && meta.band) {
          patch.band = meta.band;
          patch.bandSource = 'reported';
        }
        if (typeof meta.dense === 'boolean') patch.dense = meta.dense;
        if (meta.carrierLimits) {
          patch.carrierMinKHz  = meta.carrierLimits.minKHz;
          patch.carrierMaxKHz  = meta.carrierLimits.maxKHz;
          patch.carrierStepKHz = meta.carrierLimits.stepKHz;
        }

        // One read, used twice: to notice a firmware change, and to decide
        // whether the stored model is a placeholder worth replacing. Both need
        // the row as it was before this write.
        const before = (meta.firmware || meta.model)
          ? await prisma.inventoryDevice.findFirst({ where: { ip } })
          : null;

        // The device knows its own model, and RFDeck was throwing that away.
        //
        // A device added without one is stored as "Sennheiser Device", which
        // tells later code nothing — including the check that decides whether
        // the G3/G4 fallback may claim it. Recorded only over a placeholder,
        // never over a model an operator typed.
        if (meta.model && before && isPlaceholderModel(before.model, before.manufacturer)) {
          patch.model = meta.model;
          log.info(
            `[DeviceManager] ${ip} reported its model as "${meta.model}" ` +
            `(was "${before.model}") — recorded`,
          );
        }

        if (Object.keys(patch).length > 0) {
          await prisma.inventoryDevice.updateMany({
            where: { ip },
            data: patch,
          });

          // Only when it actually changed — see detectFirmwareChange for what
          // that excludes, and why each exclusion matters.
          const change = before && detectFirmwareChange(before.firmware, meta.firmware);
          if (before && change) {
            await prisma.maintenanceEntry.create({
              data: {
                deviceId: before.id,
                kind: 'FIRMWARE',
                summary: `Firmware changed from ${change.from} to ${change.to}`,
                detail: 'Recorded automatically when the device reported a different version.',
                automatic: true,
              },
            }).catch(err => log.warn(`[maintenance] Could not log firmware change: ${err?.message}`));

            log.info(`[DeviceManager] ${ip} firmware ${change.from} → ${change.to}`);
            this.io.emit('maintenance:changed', { deviceId: before.id });
          }
        }
        if (meta.mac) {
          await this.reconcileByMac(meta.mac, ip, port);
        }
        this.io.emit('device:metadata', { ip, port, ...meta });
      });
    }
  }

  // If an inventory device with `mac` exists at a different IP, it has changed
  // address (DHCP re-assignment after power cycle).  Update the DB and re-route
  // any active client so the frontend and future connections use the new IP.
  private async reconcileByMac(mac: string, currentIp: string, currentPort: number) {
    const stale = await prisma.inventoryDevice.findFirst({
      where: { mac, NOT: { ip: currentIp } },
    });
    if (!stale) return;

    const oldIp = stale.ip;
    const staleId = `${stale.ip}:${stale.port}`;

    // A "move" is only a move if the old address is dead. Two live devices
    // sharing a MAC — an EW-DX's control and Dante ports, or a stale ARP entry
    // handing one device's MAC to another — used to be treated as the same
    // unit changing address: the live row was rewritten, its twin deleted,
    // and every client told to drop the channel, which then came straight
    // back. On a show display that read as a receiver flapping, and nothing
    // explained it because the decision was logged below the production
    // level. Refuse, and say so where the operator will see it.
    const liveAtOld =
      this.clients.get(staleId)?.isConnected ||
      this.clients.get(`${staleId}-legacy`)?.isConnected ||
      (Date.now() - (this.lastSeen.get(staleId) ?? 0)) < 15_000;
    const secondary = this.secondaryIps.has(oldIp) || this.secondaryIps.has(currentIp);

    if (liveAtOld || secondary) {
      const why = secondary
        ? `${oldIp} and ${currentIp} are two ports of one device`
        : `the device at ${oldIp} is still in contact`;
      log.warn(
        `[DeviceManager] Not reconciling MAC ${mac} ${oldIp} → ${currentIp} ("${stale.name}"): ${why}`,
      );
      this.emitAlert({
        severity: 'INFO',
        type: 'DEVICE_SHARED_MAC',
        message: `"${stale.name}" and the device at ${currentIp} report the same hardware address; left both as they are`,
        detail: why,
        deviceId: staleId,
        deviceName: stale.name,
      });
      return;
    }

    log.warn(
      `[DeviceManager] MAC ${mac} moved: ${oldIp} → ${currentIp} ` +
      `(device: "${stale.name}"). Updating inventory.`,
    );
    this.emitAlert({
      severity: 'WARNING',
      type: 'DEVICE_IP_CHANGED',
      message: `"${stale.name}" moved from ${oldIp} to ${currentIp}`,
      detail: 'Matched by hardware address after the old address stopped answering',
      deviceId: `${currentIp}:${currentPort}`,
      deviceName: stale.name,
    });

    // Update the canonical record to the new IP
    await prisma.inventoryDevice.update({
      where: { id: stale.id },
      data: { ip: currentIp, port: currentPort },
    });

    // Stop any client still trying to reach the old IP
    const oldId       = `${oldIp}:${stale.port}`;
    const oldLegacyId = `${oldId}-legacy`;
    for (const key of [oldId, oldLegacyId]) {
      const old = this.clients.get(key);
      if (old) { old.stopPolling(); this.clients.delete(key); }
    }

    // If the discovery created a *duplicate* inventory entry at the new IP
    // (user hadn't deleted the old one yet), remove the redundant row.
    const duplicate = await prisma.inventoryDevice.findFirst({
      where: { ip: currentIp, id: { not: stale.id } },
    });
    if (duplicate) {
      await prisma.inventoryDevice.delete({ where: { id: duplicate.id } });
      this.io.emit('device:removed', { id: duplicate.id });
    }

    // Tell the frontend: the device previously at oldIp is now at currentIp
    this.io.emit('device:ip-changed', {
      id:     stale.id,
      oldIp,
      newIp:  currentIp,
      port:   currentPort,
      name:   stale.name,
    });
  }

  // Move records that were filed under a channel's NAME onto its stable id.
  //
  // Every durable record used to be keyed on the name, so an existing install
  // has patches, mic-check ticks, detections and events filed under strings
  // like "Vocal 1". Those must not be stranded: an operator who upgrades
  // between shows would find the audio patch silently unassigned and a
  // season's mic-check history detached.
  //
  // Runs once per channel, the first time it is seen, rather than as a
  // migration over the whole database — the mapping from name to stable id
  // only exists while the device is connected and reporting that channel, and
  // devices come online at different times. Nothing is overwritten: a record
  // already under the stable id means this channel has been migrated, or the
  // operator has set it since, and either way the new key wins.
  private async adoptLegacyChannelKeys(stableId: string, reportedName: string | null): Promise<void> {
    if (this.keysMigrated.has(stableId)) return;

    // Only the name the DEVICE reported can be matched against, and only once
    // it has actually arrived.
    //
    // This used to take whatever the channel was currently called, which is the
    // hardware name or, before it arrives, a fallback like "Rack 1 CH2". Metric
    // events routinely reach RFDeck before the channel resource does, so the
    // first frame after a reconnect ran this against the fallback, matched
    // nothing, and marked the channel migrated for good — stranding the rows
    // filed under the real name. The patch, the mic-check ticks and the cast
    // assignments were all still in the database, and nothing would ever look
    // for them again.
    const legacyKey = (reportedName ?? '').trim();
    if (!legacyKey) return;

    this.keysMigrated.add(stableId);
    if (legacyKey === stableId) return;

    try {
      // The audio patch, whose key is the primary key, so it is moved rather
      // than updated. Skipped entirely if this channel already has a patch.
      const [existing, legacy] = await Promise.all([
        prisma.channelAudioMap.findUnique({ where: { channelKey: stableId } }),
        prisma.channelAudioMap.findUnique({ where: { channelKey: legacyKey } }),
      ]);
      if (!existing && legacy) {
        await prisma.channelAudioMap.create({
          data: {
            channelKey:   stableId,
            deviceId:     legacy.deviceId,
            inputChannel: legacy.inputChannel,
          },
        });
        await prisma.channelAudioMap.delete({ where: { channelKey: legacyKey } });
        log.info(`[DeviceManager] Audio patch for "${legacyKey}" moved onto its stable channel id`);
      }

      // History. Re-keyed in place, since none of these have the key as their
      // primary key and a name collision between two channels would only
      // affect which incidents are grouped, not whether they survive.
      const [ticks, detections, events, mics, iems] = await Promise.all([
        prisma.micCheckEntry.updateMany({ where: { channelKey: legacyKey }, data: { channelKey: stableId } }),
        prisma.detection.updateMany({    where: { channelKey: legacyKey }, data: { channelKey: stableId } }),
        prisma.event.updateMany({        where: { channelKey: legacyKey }, data: { channelKey: stableId } }),
        // Cast assignments, so nobody loses their mic to a relabel.
        prisma.player.updateMany({ where: { assignedChannelKey: legacyKey }, data: { assignedChannelKey: stableId } }),
        prisma.player.updateMany({ where: { iemChannelKey:      legacyKey }, data: { iemChannelKey:      stableId } }),
      ]);
      const moved = ticks.count + detections.count + events.count + mics.count + iems.count;
      if (moved > 0) {
        log.info(
          `[DeviceManager] Re-keyed ${moved} record(s) from channel name "${legacyKey}" ` +
          `onto its stable id — a rename can no longer orphan them`,
        );
      }
    } catch (err: any) {
      // Never fatal: this is housekeeping, and a channel must still appear.
      this.keysMigrated.delete(stableId);
      log.warn(`[DeviceManager] Could not re-key records for "${legacyKey}": ${err?.message}`);
    }
  }

  // The identifier a channel keeps for as long as it exists.
  //
  // Built from the inventory row's uuid and the receiver slot, because those
  // are the only two things about a channel that cannot change underneath it.
  // Not the address, which DHCP reassigns; not the name, which belongs to the
  // hardware, is not RFDeck's to rely on, and can be edited at the rack in the
  // middle of a show.
  //
  // Everything durable keys on this: the audio patch, mic-check ticks,
  // detections, the event log, the operator's card order. Before it existed
  // they keyed on the channel name, so relabelling a channel silently detached
  // its patch and orphaned its history.
  //
  // Falls back to the old address-based form only while the row id is unknown,
  // which in practice means a device tracked from something other than an
  // inventory row.
  private stableChannelId(deviceId: string, slot: number): string {
    const baseId = deviceId.replace(/-legacy$/, '');
    const rowId  = this.deviceRowIds.get(baseId);
    return rowId ? `${rowId}:${slot}` : `${deviceId}-rx${slot}`;
  }

  // The prefix every channel id for this device starts with, for the maps that
  // are scoped per device rather than per channel.
  private channelIdPrefix(deviceId: string): string {
    const baseId = deviceId.replace(/-legacy$/, '');
    const rowId  = this.deviceRowIds.get(baseId);
    return rowId ? `${rowId}:` : `${deviceId}-rx`;
  }

  private clearChannelsForDevice(deviceId: string) {
    const prefix = this.channelIdPrefix(deviceId);
    const toDelete: string[] = [];
    for (const channelId of this.channelCache.keys()) {
      if (channelId.startsWith(prefix)) toDelete.push(channelId);
    }
    for (const channelId of toDelete) {
      this.channelCache.delete(channelId);
    }
  }

  // Query a connected SSC device for its network config and register its
  // secondary (Dante) addresses so discovery never shows them as new devices.
  //
  // See secondaryAddresses for why this trusts only what the device labels as
  // an address.
  private async registerSecondaryIps(client: SSCClient, ip: string, port: number): Promise<void> {
    const net = await SSCClient.fetchNetworkAddresses(ip, port, client.getPassword());
    if (!net) return;

    const secondaries = secondaryAddresses(net, ip);

    for (const sIp of secondaries) {
      if (this.secondaryIps.get(sIp) !== ip) {
        log.debug(`[DeviceManager] ${ip}: secondary (Dante) IP ${sIp} registered — suppressed from discovery`);
        this.secondaryIps.set(sIp, ip);
      }
      // Retract any discovery entries already emitted for this IP (any port).
      for (const key of [...this.discoveredCache.keys()]) {
        if (key.startsWith(`${sIp}:`)) {
          const cachedPort = parseInt(key.slice(key.lastIndexOf(':') + 1), 10);
          this.suppressDiscovered(sIp, cachedPort);
        }
      }
    }
  }

  private handleDiscovered(device: DiscoveredDevice) {
    // Known secondary interface of a tracked device — never surface it.
    if (this.secondaryIps.has(device.ip)) {
      this.reportSuppressed(device.ip, `found on the network, but it is recorded as the second interface of the device at ${this.secondaryIps.get(device.ip)} — not offering it`);
      this.suppressDiscovered(device.ip, device.port);
      return;
    }
    this.discoveredCache.set(`${device.ip}:${device.port}`, device);
    // Something is appearing on the network: worth looking again soon.
    this.resetAutoScanGap();
    this.emit('device:discovered', device);
    // If this IP isn't already tracked, check whether it's a known inventory
    // device that changed IP (e.g. DHCP re-assignment after power cycle).
    // The name comes with the discovery and was being dropped here, so every
    // unmatched-device alert reported the address where the name should be —
    // "a G3/G4 named 10.2.3.5 was found at 10.2.3.5" — which reads like RFDeck
    // knows nothing about a device it had just been told the name of.
    this.tryAutoReconcile(device.ip, device.port, device.name)
      .then(() => {
        // If the first attempt failed (e.g. ARP cache not yet populated on Windows),
        // schedule a retry after 3s without going through the seenIps-gated discovery
        // path again.  The retry is a no-op if the device was already reconciled.
        const tracked = this.clients.has(`${device.ip}:${device.port}`) ||
                        this.clients.has(`${device.ip}:${device.port}-legacy`);
        if (!tracked) {
          setTimeout(() => {
            this.tryAutoReconcile(device.ip, device.port, device.name).catch(() => {});
          }, 3_000);
        }
      })
      .catch(() => {});
  }

  // Probe a newly-discovered IP against offline inventory devices to detect
  // IP changes without requiring the user to manually edit the inventory.
  private async tryAutoReconcile(ip: string, port: number, discoveredName?: string): Promise<void> {
    if (this.clients.has(`${ip}:${port}`)) return; // already tracked

    if (port === 443) {
      // SSC device: probe the discovered IP's /api/device/identity with each
      // known inventory password until one works, then match by MAC/serial.
      const inventory = await prisma.inventoryDevice.findMany({ where: { port, active: true } });
      const passwords = [...new Set(inventory.map(d => decryptSecret(d.password ?? null)))];

      for (const password of passwords) {
        const identity = await SSCClient.fetchIdentity(ip, port, password);
        if (!identity?.mac && !identity?.serial) continue;

        // Match by MAC first (most specific), then fall back to serial.
        // EW-DX firmware omits the MAC from /api/device/identity but always includes serial.
        let known = identity.mac
          ? await prisma.inventoryDevice.findFirst({ where: { mac: identity.mac, active: true, NOT: { ip } } })
          : null;
        if (!known && identity.serial) {
          known = await prisma.inventoryDevice.findFirst({ where: { serial: identity.serial, active: true, NOT: { ip } } });
        }
        if (!known) return; // identity readable but not an inventory device — genuinely new

        // The EW-DX Dante NIC serves the same identity (same serial) as the control
        // NIC, so a serial match alone can't tell the interfaces apart — after a
        // power cycle we could migrate the record to the Dante IP by mistake.
        // Primary discriminator: ask the device for its own network config. This is
        // authoritative even in switched (single-cable) mode where both logical
        // interfaces share the physical port and possibly the MAC.
        const net = await SSCClient.fetchNetworkAddresses(ip, port, password);
        if (net) {
          if (net.controlAll.includes(ip)) {
            // This IP is the device's control interface. Migrate even if a client is
            // currently "connected" at known.ip — that connection may be to the Dante
            // NIC from an earlier mis-migration, and this corrects it.
            log.debug(`[DeviceManager] ${ip} is the control interface of "${known.name}" (record had ${known.ip}) — migrating`);
            await this.migrateDeviceIp(known, ip, port);
            return;
          }
          // The labelled Dante addresses, never the scrape of every IPv4 in the
          // payload. This branch hides the address from discovery, and the two
          // directions are not symmetrical: reading a control address wrongly
          // migrates a record, which is visible and correctable, while reading
          // a Dante address wrongly makes a real receiver impossible to add and
          // says nothing about why. When neither list names this address the
          // code falls through to the weaker heuristics below rather than
          // guessing.
          if (net.danteAddrs.includes(ip)) {
            // Secondary (Dante) interface. If the inventory record itself is sitting
            // on a non-control IP (earlier mis-migration), heal it using the control
            // address the device just reported.
            const trueControl = net.controlAddrs.find(a => a !== ip);
            if (trueControl && known.ip !== trueControl) {
              log.debug(`[DeviceManager] Healing "${known.name}": record at ${known.ip}, device reports control IP ${trueControl}`);
              await this.migrateDeviceIp(known, trueControl, port);
            }
            this.reportSuppressed(ip, `is the Dante interface of "${known.name}" — not offering it`);
            this.suppressDiscovered(ip, port);
            return;
          }
          // IP in neither list — fall through to weaker heuristics.
        }

        // Fallback 1: MAC comparison via ARP (works in split-port mode where each
        // interface has its own NIC; inconclusive when the physical port is shared).
        const arpMac = await getMacByIp(ip);
        const storedMac = known.mac?.toLowerCase() ?? null;
        if (storedMac && arpMac && arpMac !== storedMac) {
          this.reportSuppressed(ip, `has a different MAC from the control NIC of "${known.name}", so it is treated as that unit second interface — not offering it`);
          this.suppressDiscovered(ip, port);
          return;
        }

        // Fallback 2: reachability. Never steal the record from a live connection,
        // and never migrate while the recorded IP still answers with the same serial.
        if (this.clients.get(`${known.ip}:${known.port}`)?.isConnected) {
          this.reportSuppressed(ip, `matches "${known.name}", which is already connected at ${known.ip} — not offering it`);
          this.suppressDiscovered(ip, port);
          return;
        }
        const atOldIp = await SSCClient.fetchIdentity(known.ip, known.port, password);
        if (atOldIp?.serial && atOldIp.serial === identity.serial) {
          this.reportSuppressed(ip, `shares a serial with "${known.name}", which still answers at ${known.ip}, so it is treated as that unit second interface — not offering it`);
          this.suppressDiscovered(ip, port);
          return;
        }

        log.info(`[DeviceManager] Auto-reconnect: "${known.name}" found at new IP ${ip} (was ${known.ip})`);
        await this.migrateDeviceIp(known, ip, port);
        return;
      }

      // Falling out of that loop means no stored password read an identity from
      // this address. Said out loud, because the silence here is why an EW-DX
      // that had moved looked like a device RFDeck simply could not see: the
      // address was probed, refused, and nothing recorded that it had been tried.
      log.warn(
        `[DeviceManager] ${ip} answers on 443 but none of the ${passwords.length} ` +
        `stored password(s) could read an identity from it. If this is a receiver ` +
        `whose password was changed at the rack, update it in Inventory and it will ` +
        `be re-linked automatically.`,
      );
    } else if (port === 53212) {
      // G3/G4 MCP device. The neighbour entry has to be caused, not waited for.
      const mac = await this.resolveHardwareAddress(ip, () => mcpBus.sendTo(ip, 'Name'));
      if (mac) {
        // Store MAC against any inventory record that already sits at this IP but
        // hasn't had its MAC recorded yet (e.g. device added manually then reconnected).
        await prisma.inventoryDevice.updateMany({ where: { ip, mac: null }, data: { mac } });
      } else {
        // Warn, not debug: this being invisible hid a lookup that failed on
        // every headless server (`arp` is not installed on modern Ubuntu), and
        // with it the whole G3 recovery path.
        log.warn(
          `[DeviceManager] No MAC for ${ip} from the neighbour table — this ` +
          `device cannot be matched to an inventory row automatically`,
        );
      }

      // The MAC first, because it is the one key the hardware cannot be talked
      // out of.
      const stale = mac
        ? await prisma.inventoryDevice.findFirst({ where: { mac, active: true, NOT: { ip } } })
        : null;

      // ── The name, when there is no stored MAC to compare against ──────────
      //
      // This is not a nicety, it is the only other thing a G3/G4 will tell us.
      // MCP carries no serial and no identifier; the MAC comes from the OS
      // neighbour table and is only ever *written to a row* when the device
      // connects at the address that row already names. So the first time a
      // receiver changes address before it has been recorded, the cycle closes:
      // it cannot be matched without a MAC, cannot be given one without
      // connecting, cannot connect until its row has the right address, and the
      // row only gets that by being matched. Eleven receivers switched off
      // overnight came back and none of them could ever be recognised again.
      //
      // Name matching was removed once for a real reason — a relabelled unit
      // could be adopted onto another unit's record and take its history and
      // patch with it — and removing it left nothing at all. So it is back with
      // the conditions that make that impossible:
      //
      //   • only a row that has never been identified (`mac: null`), so no
      //     stored evidence is ever overridden;
      //   • when the newcomer's MAC is readable, it is recorded in the same
      //     breath, so this weaker evidence is used once and never again;
      //   • only when exactly one offline row carries that name — two devices
      //     called "Vocal 1" is a question for the operator, not a coin toss;
      //   • never a discovery placeholder, which is just the address in
      //     disguise and would make every unnamed receiver look identical.
      //
      // It deliberately does NOT require a readable MAC.
      //
      // Requiring one made the whole path dead across a router. The neighbour
      // table only holds directly-attached addresses: for anything off-link the
      // kernel resolves the next hop instead, so `ip neigh show` prints nothing
      // and no MAC for that device will ever be readable from this host. A rig
      // whose receivers sit on a different subgroup from the server — control on
      // 10.2.3.x, receivers on 10.2.5.x, which is an ordinary layout — therefore
      // got no MAC, skipped name matching entirely, and produced exactly one
      // symptom: "found at <ip> but could not be matched to any offline device",
      // for every receiver, forever, with a correct name sitting in the alert.
      //
      // So the MAC is an optimisation here, not a precondition. When it is
      // readable this runs at most once per device; when it is not, it runs on
      // each move, which is the only mechanism a routed G3/G4 has at all. Every
      // other bound above still holds, and those are what make it safe.
      let matched = stale;
      const plan = identityPlan(stale, !!mac);
      if (plan.matchByName) {
        const candidates = await prisma.inventoryDevice.findMany({
          where: { port: 53212, active: true, mac: null, NOT: { ip } },
        });
        const decision = chooseByName(discoveredName, candidates, d =>
          !!this.clients.get(`${d.ip}:${d.port}`)?.isConnected ||
          !!this.clients.get(`${d.ip}:${d.port}-legacy`)?.isConnected);

        if (decision.match) {
          matched = decision.match;
          if (plan.recordMac && mac) {
            log.info(
              `[DeviceManager] "${matched.name}" recognised at ${ip} by the name it reports ` +
              `(was ${matched.ip}); recording MAC ${mac} so this never depends on a name again`,
            );
            await prisma.inventoryDevice.update({ where: { id: matched.id }, data: { mac } });
          } else {
            log.info(
              `[DeviceManager] "${matched.name}" recognised at ${ip} by the name it reports ` +
              `(was ${matched.ip}). No MAC is readable for that address — it is not on a ` +
              `directly-attached subnet — so the name stays the only key for this device`,
            );
          }
        } else if (decision.reason) {
          log.info(`[DeviceManager] ${ip} not recognised by name: ${decision.reason}`);
        }
      }

      if (!matched) {
        // A discovered G3 that matches nothing, while G3 rows sit unreachable,
        // is almost certainly one of them wearing a new address that cannot be
        // proven. Silence here left the operator staring at offline devices
        // with no explanation — say it once, where they look.
        const unreachable = await prisma.inventoryDevice.findMany({
          where: { port: 53212, active: true },
        });
        const anyDown = unreachable.some(d =>
          !this.clients.get(`${d.ip}:${d.port}`)?.isConnected &&
          !this.clients.get(`${d.ip}:${d.port}-legacy`)?.isConnected);
        const sightings = (this.orphanSightings.get(ip) ?? 0) + 1;
        this.orphanSightings.set(ip, sightings);
        if (anyDown && sightings > 1 && !this.orphanAlerted.has(ip)) {
          this.orphanAlerted.add(ip);
          this.emitAlert({
            severity: 'WARNING',
            type: 'DEVICE_UNMATCHED',
            message: `A G3/G4 named "${discoveredName ?? ip}" was found at ${ip} but could not be matched to any offline device`,
            detail: 'RFDeck will keep trying on each scan, so this may resolve on its own. '
              + 'If it does not, set that device\'s address to this one in Inventory (or '
              + 're-add it from Discovery), and its identity will be recorded so it is not '
              + 'needed again.',
            deviceId: `${ip}:${port}`,
          });
        }
        // Says what was actually considered, because "no match" on its own is
        // indistinguishable from discovery being broken — which is exactly how
        // this bug presented, and why it went unexplained for so long.
        const nullMacs = unreachable.filter(d => !d.mac).length;
        log.warn(
          `[DeviceManager] tryAutoReconcile: nothing matches ${ip} ` +
          `(label="${discoveredName ?? ''}", mac=${mac ?? 'none'}); ` +
          `${unreachable.length} G3/G4 row(s) known, ${nullMacs} of them with no recorded MAC` +
          (mac ? '' : ' — a probe was sent to this address and it still has no neighbour ' +
            'table entry, so only the name it reports could be compared'),
        );
        return;
      }
      if (this.clients.get(`${matched.ip}:${matched.port}`)?.isConnected) {
        log.debug(`[DeviceManager] tryAutoReconcile: old client at ${matched.ip}:${matched.port} still connected`);
        return;
      }

      log.info(`[DeviceManager] Auto-reconnect: G3/G4 "${matched.name}" found at new IP ${ip} (was ${matched.ip})`);
      await this.migrateDeviceIp(matched, ip, port);
    } else {
      // Everything else: Shure, Digital 6000, and whatever is added next.
      await this.reconcileByHardwareAddress(ip, port, discoveredName);
    }
  }


  /**
   * Offer stored passwords to an address that asked for credentials — once per
   * set of passwords, not once per address.
   *
   * The distinction is the whole point. Retrying the same passwords against the
   * same host every sweep cannot succeed where it just failed, and each attempt is
   * a round of authenticated HTTPS that competes with telemetry. But an address
   * already tried is *not* settled: an EW-DX that has been re-adopted in Sennheiser
   * Control Cockpit comes back with a new password, the operator types it into
   * RFDeck, and the very next sweep has to try it. Keyed on the address alone that
   * retry never happens and the receiver stays offline until somebody presses a
   * button — which is the state this was supposed to end.
   *
   * So what is remembered is which *passwords* were tried here. Change one, add
   * one, remove one, and the signature changes and the address is tried again on
   * its own.
   */
  private readonly credentialsTried = new Map<string, string>();

  private async tryCredentialsOnce(ip: string, port: number): Promise<void> {
    try {
      const rows = await prisma.inventoryDevice.findMany({ where: { port, active: true } });
      const secrets = rows
        .map(d => decryptSecret(d.password ?? null) ?? '')
        .filter(Boolean)
        .sort();
      // A digest, so nothing derived from a password is held in memory in a form
      // that could be read back out of it.
      const signature = secrets.length === 0
        ? 'none'
        : crypto.createHash('sha256').update(secrets.join(String.fromCharCode(0))).digest('hex');

      if (this.credentialsTried.get(ip) === signature) {
        log.debug(`[DeviceManager] ${ip} already tried with these passwords — not repeating`);
        return;
      }
      this.credentialsTried.set(ip, signature);

      log.info(
        `[DeviceManager] ${ip} wants credentials and an SSC device is unreachable — ` +
        `trying the ${secrets.length} password(s) stored for this rig`,
      );
      await this.tryAutoReconcile(ip, port);
    } catch (err: any) {
      log.debug(`[DeviceManager] credential attempt for ${ip} failed: ${err?.message}`);
    }
  }


  /**
   * Re-link a device of any protocol that has changed address.
   *
   * Reconciliation was written twice, once for SSC and once for G3/G4, and the
   * function simply fell off the end for anything else. A Shure receiver or a
   * Digital 6000 that came back on a different address was never matched, never
   * migrated and never even reported — the branch did not exist, so there was not
   * so much as a log line. It looked identical to a device that was not there.
   *
   * The identity used here is the hardware address from the OS neighbour table,
   * which is the one key that does not care what a device speaks. Every protocol
   * answers ARP; only some of them offer a serial. That makes this the right
   * default for a family RFDeck has not met yet, rather than a gap that waits for
   * somebody to notice their rig is not coming back.
   *
   * What it cannot do is identify a device on the far side of a router, where
   * there is no neighbour entry to read. For SSC that does not matter — the
   * device reports its own serial — and for the rest it is a real limit, said
   * out loud in the alert rather than left as silence.
   */
  private async reconcileByHardwareAddress(
    ip: string, port: number, discoveredName?: string,
  ): Promise<void> {
    // No assumption about transport here, so there is nothing to nudge with: the
    // caller reached this address somehow, and if that left no neighbour entry
    // there is nothing further this can do. Said plainly rather than retried in
    // hope. See resolveHardwareAddress.
    const mac = await this.resolveHardwareAddress(ip);

    if (mac) {
      // Record it against a row already at this address, so the next move is
      // provable rather than guessed at.
      const { count } = await prisma.inventoryDevice.updateMany({
        where: { ip, mac: null }, data: { mac },
      });
      if (count > 0) {
        log.info(`[DeviceManager] Recorded MAC ${mac} for the device at ${ip}`);
      }
    }

    let matched = mac
      ? await prisma.inventoryDevice.findFirst({ where: { mac, active: true, NOT: { ip } } })
      : null;

    // The same bounded name match the G3/G4 path uses, for a row that has never
    // been identified. Held to the same conditions, for the same reason: a name
    // is the operator's and can be duplicated, so it may only ever recover an
    // identity that was never captured, never override one that was.
    //
    // And, as there, it does not require a readable MAC: off-link devices have no
    // neighbour entry, and gating on one meant the fallback did nothing in exactly
    // the case it was written for.
    if (identityPlan(matched, !!mac).matchByName) {
      const candidates = await prisma.inventoryDevice.findMany({
        where: { port, active: true, mac: null, NOT: { ip } },
      });
      const decision = chooseByName(discoveredName, candidates, d =>
        !!this.clients.get(`${d.ip}:${d.port}`)?.isConnected);
      if (decision.match) {
        matched = decision.match;
        if (mac) {
          log.info(
            `[DeviceManager] "${matched.name}" recognised at ${ip} by the name it reports ` +
            `(was ${matched.ip}); recording MAC ${mac}`,
          );
          await prisma.inventoryDevice.update({ where: { id: matched.id }, data: { mac } });
        } else {
          // Nothing to record: there is no neighbour entry for an off-link
          // address. Writing null here would only claim, in the log, to have
          // stored an identity that does not exist.
          log.info(
            `[DeviceManager] "${matched.name}" recognised at ${ip} by the name it reports ` +
            `(was ${matched.ip}). No hardware address is readable for that address, so the ` +
            `name stays the only key for this device`,
          );
        }
      }
    }

    if (!matched) {
      const rows = await prisma.inventoryDevice.findMany({ where: { port, active: true } });
      const anyDown = rows.some(d => !this.clients.get(`${d.ip}:${d.port}`)?.isConnected);
      const sightings = (this.orphanSightings.get(ip) ?? 0) + 1;
      this.orphanSightings.set(ip, sightings);
      if (anyDown && sightings > 1 && !this.orphanAlerted.has(ip)) {
        this.orphanAlerted.add(ip);
        this.emitAlert({
          severity: 'WARNING',
          type: 'DEVICE_UNMATCHED',
          message: `A device named "${discoveredName ?? ip}" was found at ${ip} but could not be matched to any offline device`,
          detail: mac
            ? 'None of the offline devices has this hardware address on record. Point the right one at this address in Inventory and its identity will be stored, so this never needs doing again.'
            : 'Its hardware address could not be read, which usually means it is on the far side of a router from this server. Set its address in Inventory to adopt it.',
          deviceId: `${ip}:${port}`,
        });
      }
      log.warn(
        `[DeviceManager] tryAutoReconcile: nothing matches ${ip}:${port} ` +
        `(label="${discoveredName ?? ''}", mac=${mac ?? 'none'}); ` +
        `${rows.length} row(s) on this port, ${rows.filter(d => !d.mac).length} with no recorded MAC`,
      );
      return;
    }

    if (this.clients.get(`${matched.ip}:${matched.port}`)?.isConnected) return;

    log.info(`[DeviceManager] Auto-reconnect: "${matched.name}" found at new IP ${ip} (was ${matched.ip})`);
    await this.migrateDeviceIp(matched, ip, port);
  }

  /**
   * Read the device's hardware address, having first given the kernel a reason to
   * know it.
   *
   * The neighbour table is not a directory. An entry exists because this host
   * needed to *send* to that address and resolved it; inbound traffic alone does
   * not reliably create one. So a receiver discovered by its reply to a broadcast
   * probe — which is how a G3/G4 that has just powered on is normally found — has
   * no entry, and no amount of waiting produces one.
   *
   * The previous version read the table four times, 400 ms apart, with a comment
   * saying the entry appears "once we send a UDP probe to this IP" while sending
   * nothing. When the lookup came up empty the device was declared unmatchable and
   * the operator was told to correct its address by hand. It then recovered on its
   * own some minutes later, on a later scan that happened to have sent to it: the
   * alert had been describing a gap in RFDeck's own knowledge as a fault in the rig.
   *
   * So: send first, then look. `nudge` is one datagram on a protocol the caller
   * knows the device speaks. The retries afterwards are waiting on something that
   * was actually set in motion.
   */
  private async resolveHardwareAddress(
    ip: string,
    nudge?: () => void,
  ): Promise<string | null> {
    // Off-link: there is nothing to cause and nothing to wait for. Say so once,
    // rather than sending a probe and polling a table that cannot answer.
    if (!isDirectlyAttached(ip, mcpBus.getActiveInterfaces())) {
      this.reportSuppressed(
        ip,
        'is not on a subnet this server is attached to, so its hardware address ' +
        'cannot be read here and identity has to rest on the name it reports',
      );
      return null;
    }

    if (nudge) {
      try { nudge(); } catch { /* a probe that cannot be sent is not fatal here */ }
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const mac = await getMacByIp(ip);
      if (mac) return mac;
      await new Promise<void>(r => setTimeout(r, 400));
    }
    return null;
  }

  private async migrateDeviceIp(
    dev: { id: string; name: string; ip: string; port: number },
    newIp: string,
    newPort: number,
  ): Promise<void> {
    const oldIp = dev.ip;
    const oldPort = dev.port;

    await prisma.inventoryDevice.update({
      where: { id: dev.id },
      data: { ip: newIp, port: newPort },
    });

    this.untrackDevice(oldIp, oldPort);

    // Reload full row from DB so trackDevice gets password, mac, etc.
    const updated = await prisma.inventoryDevice.findUnique({ where: { id: dev.id } });
    if (updated) this.trackDevice(updated);

    this.io.emit('device:ip-changed', {
      id: dev.id, oldIp, newIp, port: newPort, name: dev.name,
    });

    // An unmatched warning about this address, if one was raised, is now false.
    //
    // It was keyed on the address the device turned up at, and `untrackDevice`
    // above clears the one it *left* — so the warning outlived the problem
    // indefinitely. The operator was left holding a WARNING telling them to
    // correct an address by hand, for a device that was already synced and
    // working. Saying so costs one INFO and is the difference between an alert
    // log that can be trusted and one that has to be second-guessed.
    this.orphanSightings.delete(newIp);
    if (this.orphanAlerted.delete(newIp)) {
      this.emitAlert({
        severity: 'INFO',
        type: 'DEVICE_UNMATCHED',
        message: `"${dev.name}" was recognised at ${newIp} after all — no action is needed`,
        detail: `It had been reported as found but unmatchable. It has been linked to its `
          + `inventory record automatically and moved from ${oldIp} to ${newIp}.`,
        deviceId: `${newIp}:${newPort}`,
        deviceName: dev.name,
      });
    }
  }

  // Remove a discovered entry that turned out to be a secondary interface of an
  // already-tracked device (e.g. the Dante NIC of a connected EW-DX).
  /**
   * Say, once, that a device was found and deliberately not offered.
   *
   * These decisions were all logged at `debug`, and a deployed server runs at
   * `warn` — so RFDeck could see a receiver, decide it was a duplicate or a
   * second interface, and hide it, leaving nothing in the journal at all. To
   * an operator looking at a receiver that is plainly on the network and
   * plainly not in the list, that is indistinguishable from discovery being
   * broken, and there was no way to tell the two apart from the outside.
   *
   * Every one of these judgements can be wrong — they rest on MACs, serials
   * and addresses reported by the hardware — so each one says what it decided
   * and why, at a level the operator actually sees. Once per address per run,
   * since the scans repeat.
   */
  private reportSuppressed(ip: string, why: string): void {
    if (this.suppressionReported.has(ip)) return;
    this.suppressionReported.add(ip);
    log.warn(`[DeviceManager] ${ip} ${why}. If that is wrong, add it by IP from the inventory.`);
  }

  private suppressDiscovered(ip: string, port: number) {
    this.discoveredCache.delete(`${ip}:${port}`);
    this.io.emit('device:undiscovered', { ip, port });
  }

  getDiscoveredSnapshot(): any[] {
    return Array.from(this.discoveredCache.values());
  }


  // Clamp a hardware-reported figure into a sane 0–100 meter value.
  // Everything arriving from a device is untrusted: firmware quirks and partial
  // MCP frames have produced NaN and out-of-range values, which then render as
  // broken meters or NaN% in the UI. Coercing here keeps malformed readings from
  // ever reaching React.
  private static meterValue(raw: unknown, fallback = 0): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(100, Math.max(0, n));
  }

  private normalizeAndEmit(deviceId: string, sscState: any) {
    if (!sscState || typeof sscState !== 'object') return;

    // Resolve the base device id (strip -legacy suffix added for G3/G4 clients)
    const baseId = deviceId.replace(/-legacy$/, '');
    const inventoryName = this.deviceNames.get(baseId);

    const receivers = ['rx1', 'rx2', 'rx3', 'rx4'];

    receivers.forEach((rx, index) => {
      if (sscState[rx] && typeof sscState[rx] === 'object') {
        const rxData = sscState[rx];

        // A slot the operator has marked as not in use produces no channel at
        // all — no card, no mic-check row, and nothing for the RF and battery
        // alerting below to fire on. An empty slot on a multi-channel receiver
        // otherwise sits at 0% RF forever and reads as a fault.
        if (this.slotDisabled(deviceId, index + 1)) return;

        const channelId = this.stableChannelId(deviceId, index + 1);

        // RF quality: G3/G4 sends 0-100 directly; SSCv2 also 0-100.
        // rf_quality may be undefined for IEM/output devices that don't receive RF —
        // only flag CRITICAL when we actually have RF data AND it's low.
        const rawRf = rxData.rf_quality;
        const rfKnown = rawRf !== undefined && rawRf !== null && Number.isFinite(Number(rawRf));
        const rfA = rfKnown ? DeviceManagerService.meterValue(rawRf) : 0;
        const rfB = rxData.rf_quality_b !== undefined && rxData.rf_quality_b !== null
          ? DeviceManagerService.meterValue(rxData.rf_quality_b, rfA)
          : rfA;

        // AF level: raw dBFS (-60..0) → 0-100 display percentage
        const rawAf = Number(rxData.af_level);
        const afLevel = Number.isFinite(rawAf)
          ? DeviceManagerService.meterValue(100 + rawAf)
          : 0;

        // Channel name priority: device-reported name → inventory device name → generic label
        const channelCount = Object.keys(sscState).filter(k => /^rx\d+$/.test(k)).length;
        const deviceLabel = inventoryName ?? baseId;
        // EW-DX pushes each channel as its own event, so counting the rx keys
        // in ONE emission always said "single channel" and named an unnamed
        // rx2 identically to rx1. The rx index itself, and any cached
        // siblings, are what actually establish a multi-channel device.
        const hasSiblings = [...this.channelCache.keys()]
          .some(k => k.startsWith(this.channelIdPrefix(deviceId)) && k !== channelId);
        const fallbackName = (channelCount > 1 || index > 0 || hasSiblings)
          ? `${deviceLabel} CH${index + 1}`
          : deviceLabel;

        // isMuted = user-requested mute only (not TX squelch)
        const isMuted = rxData.mute === true;
        // squelch = transmitter below threshold (TX_Mute from device)
        const isSquelch = rxData.squelch === true;
        // TX mute is the performer's own switch — deliberate, not a fault, so
        // it no longer degrades status to WARNING. It travels as its own flag
        // and the views render it as a mute.
        // What the channel is for. The device wins where it knows: a Shure
        // PSM1000 is an IEM transmitter whatever the operator ticked when
        // adding it, and the hardware is the better authority. Otherwise the
        // inventory's deviceType decides.
        //
        // The '-legacy' suffix is a Sennheiser artefact of the id, not part of
        // how the device was catalogued.
        const role = rxData.role ?? this.deviceRoles.get(baseId) ?? 'mic';

        // An IEM is never CRITICAL for want of RF: it has none to want.
        const status = isMuted ? 'WARNING'
                     : (role !== 'iem' && rfKnown && rfA < 20) ? 'CRITICAL'
                     : 'ACTIVE';

        // Battery may be absent (no transmitter paired) — distinguish that from
        // a reported zero, and reject non-finite values outright.
        const rawBattery = rxData.battery?.percent;
        const batteryPercent =
          rawBattery === undefined || rawBattery === null || !Number.isFinite(Number(rawBattery))
            ? undefined
            : DeviceManagerService.meterValue(rawBattery);

        const rawFreq = Number(rxData.frequency);
        const rawGain = Number(rxData.audio?.gain);

        const newChannel: Channel = {
          id: channelId,
          deviceId: deviceId,
          channelIndex: index + 1,
          name: typeof rxData.name === 'string' && rxData.name.trim()
            ? rxData.name
            : fallbackName,
          frequency: Number.isFinite(rawFreq) && rawFreq > 0 ? rawFreq : 0,
          rfLevelA: rfA,
          rfLevelB: rfB,
          afLevel: afLevel,
          batteryPercent,
          isMuted,
          isTxMuted: isSquelch,
          gain: Number.isFinite(rawGain) ? rawGain : 0,
          role,
          status,
        };


        // Anything filed against this channel under its name, before channels
        // had an id that could not change, is moved across once the device has
        // said what the channel is called. The fallback label is deliberately
        // not passed: it matches nothing, and passing it would end the search.
        void this.adoptLegacyChannelKeys(
          channelId,
          typeof rxData.name === 'string' && rxData.name.trim() ? rxData.name : null,
        );

        // Check if anything changed
        const oldChannel = this.channelCache.get(channelId);
        if (JSON.stringify(oldChannel) !== JSON.stringify(newChannel)) {
          this.channelCache.set(channelId, newChannel);
          this.io.emit('channel:telemetry', newChannel);
          // A frequency moving is the only thing that can change the intermod
          // picture, and it is rare; telemetry is not.
          this.refreshIntermod();

          // Alert Engine Logic
          if (oldChannel) {
            // Mute
            if (!oldChannel.isMuted && newChannel.isMuted) {
              this.emitAlert({
                severity: 'WARNING',
                type: 'MUTED',
                message: `Channel muted`,
                channelId,
                channelName: newChannel.name,
                deviceId
              });
            }

            // Battery
            const oldBatt = oldChannel.batteryPercent;
            const newBatt = newChannel.batteryPercent;
            if (oldBatt !== undefined && newBatt !== undefined) {
              // A threshold crossing must hold for two consecutive samples.
              // Transmitters report garbage while re-syncing, and one bad
              // sample raised a CRITICAL alert on a full pack in a live show.
              const crossedLow      = oldBatt > 20 && newBatt <= 20 && newBatt > 5;
              const crossedCritical = oldBatt > 5  && newBatt <= 5;
              const pending = this.pendingLowBattery.get(channelId);

              if (newBatt > 20) {
                this.pendingLowBattery.delete(channelId);
              } else if (pending !== undefined && newBatt <= pending) {
                // Second consecutive low reading: now it is real.
                this.pendingLowBattery.delete(channelId);
                const critical = newBatt <= 5;
                this.emitAlert({
                  severity: critical ? 'CRITICAL' : 'WARNING',
                  type: critical ? 'CRITICAL_BATTERY' : 'LOW_BATTERY',
                  message: critical ? `Battery critical (${newBatt}%)` : `Battery low (${newBatt}%)`,
                  channelId,
                  channelName: newChannel.name,
                  deviceId
                });
              } else if (crossedLow || crossedCritical) {
                this.pendingLowBattery.set(channelId, newBatt);
              }
            }

            // A carrier moving is part of the RF environment's history, and
            // until now nothing server-side noticed: it was tracked in a browser
            // store, so it was per-client and lost on reload.
            if (oldChannel.frequency > 0 && newChannel.frequency > 0
                && oldChannel.frequency !== newChannel.frequency) {
              this.emit('channel:frequency', {
                channelId,
                channelName: newChannel.name,
                deviceId,
                fromKHz: oldChannel.frequency,
                toKHz: newChannel.frequency,
              });
            }

            // RF dropout / recovery — see evaluateRfState.
            this.evaluateRfState(channelId, deviceId, oldChannel, newChannel);
          }

          // Battery runtime projection — sampled on an interval regardless of
          // whether this was the first reading for the channel.
          this.sampleBattery(channelId, newChannel);
        }
      }
    });
  }

  // ── RF dropout / recovery detection ──
  //
  // This runs on the server and is broadcast, because RFDeck serves several
  // clients at once. When each browser derived its own events they diverged:
  // a client that was closed missed events entirely, two operators comparing
  // logs disagreed, and no log was authoritative enough to build a show report
  // from.
  //
  // Hysteresis with a confirmation window: a dropout is only real once the
  // signal STAYS below DROPOUT_THRESHOLD for DROPOUT_CONFIRM_MS. EW-DX
  // diversity switching flaps 0%→100% within a second, and without the window
  // that produced a dropout/recovery pair every second.
  private evaluateRfState(
    channelId: string,
    deviceId: string,
    oldChannel: Channel,
    newChannel: Channel,
  ): void {
    const state = this.rfStates.get(channelId) ?? 'OK';
    const action = evaluateSample(
      state,
      newChannel,
      this.rfThresholds,
      this.pendingDropouts.has(channelId),
    );

    switch (action.kind) {
      case 'arm': {
        const timer = setTimeout(() => {
          this.pendingDropouts.delete(channelId);
          const current = this.channelCache.get(channelId);
          if (!confirmDropout(current, this.rfThresholds)) return;

          this.rfStates.set(channelId, 'DROPOUT');
          this.emitRfEvent('DROPOUT', channelId, deviceId, current!);

          // Alerts are rate-limited separately from events: the log wants every
          // dropout, the alert feed does not want one a minute per channel.
          const lastAlert = this.lastDropoutAlertAt.get(channelId) ?? 0;
          if (Date.now() - lastAlert >= this.DROPOUT_REALERT_MS) {
            this.lastDropoutAlertAt.set(channelId, Date.now());
            this.emitAlert({
              severity: 'CRITICAL',
              type: 'DROPOUT',
              message: 'RF Dropout detected',
              channelId,
              channelName: current!.name,
              deviceId,
            });
          }
        }, this.rfThresholds.confirmMs);
        this.pendingDropouts.set(channelId, timer);
        break;
      }

      case 'disarm': {
        const pending = this.pendingDropouts.get(channelId);
        if (pending) {
          clearTimeout(pending);
          this.pendingDropouts.delete(channelId);
        }
        break;
      }

      case 'recovered':
        this.rfStates.set(channelId, 'OK');
        this.emitRfEvent('RECOVERY', channelId, deviceId, newChannel);
        break;
    }
  }

  private emitRfEvent(
    type: 'DROPOUT' | 'RECOVERY',
    channelId: string,
    deviceId: string,
    channel: Channel,
  ): void {
    const event = {
      id: crypto.randomUUID(),
      type,
      channelId,
      channelName: channel.name,
      deviceId,
      rfLevelA: channel.rfLevelA,
      rfLevelB: channel.rfLevelB,
      timestamp: new Date().toISOString(),
    };
    this.rfEventLog.unshift(event);
    if (this.rfEventLog.length > this.RF_EVENT_LOG_MAX) {
      this.rfEventLog.length = this.RF_EVENT_LOG_MAX;
    }
    this.io.emit('rf:event', event);
    // Also as an EventEmitter signal, for anything that wants the *complete* RF
    // record rather than the throttled human-facing alert feed. The cloud event
    // stream is the case that matters: an event history showing dropouts and no
    // recoveries would be worse than none, because it reads as a rig that never
    // came back.
    this.emit('rf:event', event);

    // A dropout is the first thing worth keeping audio for. Emitted as its own
    // signal rather than calling the recorder directly, so device tracking
    // stays independent of whether recording exists at all.
    if (type === 'DROPOUT') {
      this.emit('rf:detection', {
        channelKey:  channelId,
        channelName: channel.name,
        deviceId,
        trigger:     'RF_DROPOUT',
        severity:    'CRITICAL',
        message:     `RF dropout on ${channel.name}`,
        rfLevelA:    Math.round(channel.rfLevelA),
        rfLevelB:    Math.round(channel.rfLevelB),
      });
    }

    // Persist so the history survives a restart and can back a show report.
    // Fire-and-forget: a database hiccup must never interrupt live monitoring.
    prisma.event.create({
      data: {
        id: event.id,
        timestamp: new Date(event.timestamp),
        source: 'RF',
        type,
        severity: type === 'DROPOUT' ? 'CRITICAL' : 'INFO',
        message: type === 'DROPOUT' ? 'Signal dropout' : 'Signal recovered',
        channelKey: channelId,
        channelName: channel.name,
        deviceId,
        rfLevelA: Math.round(channel.rfLevelA),
        rfLevelB: Math.round(channel.rfLevelB),
      },
    }).catch(err => log.warn('[DeviceManager] Could not persist RF event:', err?.message));
  }

  clearRfEvents(): void {
    this.rfEventLog = [];
    this.io.emit('rf:events-cleared');
  }

  // Replayed to a client that connects mid-show so it isn't starting blank.
  getRfEventSnapshot(): any[] {
    return this.rfEventLog;
  }

  // ── Battery runtime ──
  // Sampled and projected on the server so every client shows the same figure,
  // and so history survives a client reload.
  private sampleBattery(channelId: string, channel: Channel): void {
    if (channel.batteryPercent === undefined) return;

    const now = Date.now();
    const last = this.lastBatterySampleAt.get(channelId) ?? 0;
    if (now - last < this.BATTERY_SAMPLE_INTERVAL_MS) return;
    this.lastBatterySampleAt.set(channelId, now);

    const history = addSample(
      this.batteryHistory.get(channelId) ?? [],
      { t: now, percent: channel.batteryPercent },
    );
    this.batteryHistory.set(channelId, history);

    const est = estimateBattery(history);
    if (!est) return;

    const previous = this.batteryEstimates.get(channelId);
    this.batteryEstimates.set(channelId, est);

    // Only push when the displayed value would actually change — an estimate
    // drifting by seconds is not worth a broadcast to every client.
    const changedMinute =
      previous?.minutesRemaining === null || previous === undefined
        ? est.minutesRemaining !== null
        : est.minutesRemaining === null ||
          Math.abs((previous.minutesRemaining ?? 0) - (est.minutesRemaining ?? 0)) >= 1;

    if (changedMinute || previous?.confident !== est.confident) {
      this.io.emit('battery:estimate', { channelId, ...est });
    }
  }

  // Keep the persisted log bounded: drop anything older than the retention
  // window, then trim by count in case a single run produced a flood.
  private async pruneEvents(): Promise<void> {
    const RETENTION_DAYS = 90;
    const MAX_ROWS = 50_000;

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    const byAge = await prisma.event.deleteMany({ where: { timestamp: { lt: cutoff } } });

    const total = await prisma.event.count();
    let byCount = 0;
    if (total > MAX_ROWS) {
      // Find the timestamp of the newest row we intend to keep, then delete
      // everything older in one statement rather than row by row.
      const boundary = await prisma.event.findMany({
        orderBy: { timestamp: 'desc' },
        skip: MAX_ROWS - 1,
        take: 1,
        select: { timestamp: true },
      });
      if (boundary[0]) {
        const result = await prisma.event.deleteMany({
          where: { timestamp: { lt: boundary[0].timestamp } },
        });
        byCount = result.count;
      }
    }

    if (byAge.count || byCount) {
      log.info(`[DeviceManager] Pruned ${byAge.count + byCount} old event(s)`);
    }
  }

  getBatteryEstimateSnapshot(): Array<{ channelId: string } & BatteryEstimate> {
    return Array.from(this.batteryEstimates.entries())
      .map(([channelId, est]) => ({ channelId, ...est }));
  }

  // --- Discovery ---

  // Trigger a full network scan (UDP probes + HTTP sweep).
  // Called externally when the user opens the Add Device dialog.
  async triggerScan(): Promise<void> {
    // Operator-initiated: they are saying something on the network has
    // changed, so previously rejected addresses get another look.
    await this.discovery.scan(true);
  }

  get isScanInProgress(): boolean {
    return this.discovery.isScanning;
  }

  // Auto-triggered when a device goes offline; debounced to avoid hammering
  // the network when several devices drop at the same time.
  /** Something changed, so look again promptly rather than at the backed-off rate. */
  private resetAutoScanGap(): void {
    this.autoScanGapMs = this.AUTO_SCAN_COOLDOWN_MS;
  }

  private maybeAutoScan() {
    const now = Date.now();
    if (now - this.lastAutoScanAt < this.autoScanGapMs) return;
    this.lastAutoScanAt = now;

    // Back off while nothing is changing.
    //
    // A sweep repeats for as long as a device is missing, and a device can be
    // missing because it is switched off for the weekend. At a fixed twenty
    // seconds that is a permanent scan of somebody's network, which is how
    // RFDeck ended up interfering with traffic that had nothing to do with it.
    //
    // The gap doubles each time a sweep changes nothing and resets the moment
    // anything does — a device connecting, or discovery finding something. So a
    // rig that comes back is still found quickly, and a rig that is genuinely
    // away is looked for a few times an hour instead of a few times a minute.
    this.autoScanGapMs = Math.min(this.autoScanGapMs * 2, this.AUTO_SCAN_GAP_MAX_MS);
    log.debug('[DeviceManager] Device went offline — triggering discovery scan');
    void this.scanForMissingDevices();
  }

  /**
   * Tell discovery where this rig's hardware lives, then scan.
   *
   * Discovery on its own only knows the subnets of the server's own network
   * interfaces, so a rig on its own VLAN — or one device that moved onto another —
   * was never swept and never found. The inventory is the missing half of that
   * picture: every row records where its device last answered, and that stays true
   * about the *network* long after the host part has changed.
   *
   * Passed on every scan rather than once at startup, so a device added or edited
   * since is included without anything else having to remember to say so.
   */
  private async scanForMissingDevices(): Promise<void> {
    try {
      const rows = await prisma.inventoryDevice.findMany({
        where: { active: true },
        select: { ip: true },
      });
      this.discovery.setSearchHints(rows.map(r => r.ip));
    } catch (err: any) {
      // A scan of the interface subnets alone is still better than no scan.
      log.debug(`[DeviceManager] Could not read inventory for search hints: ${err?.message}`);
    }
    await this.discovery.scan().catch(() => {});
  }

  // ── Alerts ──
  // Server-owned so acknowledgement is shared. When each client tracked its own
  // ack state, one operator clearing an alert left it live for everyone else —
  // the classic duplicated-response failure during a show.
  private alerts: any[] = [];
  private readonly ALERT_LOG_MAX = 500;

  private emitAlert(params: { severity: any, type: any, message: string, detail?: string, channelId?: string, channelName?: string, deviceId?: string, deviceName?: string }) {
    const alert = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      acknowledged: false,
      acknowledgedBy: null,
      dismissed: false,
      ...params
    };
    this.alerts.unshift(alert);
    if (this.alerts.length > this.ALERT_LOG_MAX) {
      this.alerts.length = this.ALERT_LOG_MAX;
    }
    this.io.emit('alert:new', alert);
    // For anything that wants alerts out of the browser — push, the cloud event tap.
    // Emitted on this object rather than dispatched from here, so a delivery
    // failure can never reach back into the telemetry path.
    this.emit('alert', alert);

    prisma.event.create({
      data: {
        id: alert.id,
        timestamp: new Date(alert.timestamp),
        source: 'ALERT',
        type: String(params.type),
        severity: String(params.severity),
        message: params.message,
        // The id, never the name: an alert must stay attached to the channel
        // that raised it even after someone relabels that channel at the rack.
        channelKey: params.channelId ?? null,
        channelName: params.channelName ?? null,
        deviceId: params.deviceId ?? null,
      },
    }).catch(err => log.warn('[DeviceManager] Could not persist alert:', err?.message));
  }

  getAlertSnapshot(): any[] {
    return this.alerts;
  }

  setAlertState(id: string, patch: { acknowledged?: boolean; dismissed?: boolean; by?: string | null }): boolean {
    const alert = this.alerts.find(a => a.id === id);
    if (!alert) return false;
    if (patch.acknowledged !== undefined) {
      alert.acknowledged = patch.acknowledged;
      alert.acknowledgedBy = patch.acknowledged ? (patch.by ?? null) : null;
    }
    if (patch.dismissed !== undefined) alert.dismissed = patch.dismissed;
    this.io.emit('alert:updated', alert);

    prisma.event.updateMany({
      where: { id },
      data: {
        acknowledged: alert.acknowledged,
        acknowledgedBy: alert.acknowledgedBy,
        dismissed: alert.dismissed,
      },
    }).catch(() => {});
    return true;
  }

  clearAlerts(): void {
    this.alerts = [];
    this.io.emit('alerts:cleared');
  }

  // --- State snapshot (for replaying to newly-connected frontend clients) ---

  /**
   * Recompute which intermodulation products land on a live channel.
   *
   * Called from the telemetry path, which runs several times a second, so the
   * first thing it does is establish that nothing relevant has moved. Only a
   * frequency changing can alter the answer, and frequencies change when
   * somebody re-tunes something — a handful of times a day, not a handful of
   * times a second.
   *
   * Mics only. An IEM transmitter is a source of products like anything else,
   * but it is not a victim: it receives nothing, so nothing can land on it.
   */
  private refreshIntermod(): void {
    const sources = this.getChannelSnapshot()
      .filter(c => c.role !== 'iem')
      .map(c => ({ id: c.id, name: c.name, frequencyKHz: c.frequency }));

    const sig = intermodSignature(sources);
    if (sig === this.intermodSig) return;
    this.intermodSig = sig;

    const before = this.intermod.hits.length;
    this.intermod = findIntermodHits(sources);
    this.io.emit('intermod:report', this.intermod);

    // Only when the picture actually changes, which the signature check above
    // already guarantees — the report is recomputed on every carrier move, and an
    // event per recomputation would bury a real finding in noise.
    if (this.intermod.hits.length !== before) {
      this.emit('intermod:changed', {
        hits: this.intermod.hits.length,
        sourceCount: this.intermod.sourceCount,
        worst: this.intermod.hits[0]
          ? {
              formula: this.intermod.hits[0].formula,
              victimName: this.intermod.hits[0].victimName,
              offsetKHz: this.intermod.hits[0].offsetKHz,
            }
          : null,
      });
    }

    if (this.intermod.hits.length > 0) {
      const worst = this.intermod.hits[0];
      log.info(
        `[intermod] ${this.intermod.hits.length} product(s) land on a live channel; ` +
        `closest is ${worst.formula} at ${Math.abs(worst.offsetKHz)} kHz from "${worst.victimName}"`,
      );
    }
  }

  getIntermodReport(): IntermodReport { return this.intermod; }

  getChannelSnapshot(): Channel[] {
    return Array.from(this.channelCache.values());
  }

  // Devices currently refusing the stored password, for replay to a client that
  // connects after the failure was first seen.
  getAuthFailures(): Array<{ ip: string; port: number; reason: string }> {
    const out: Array<{ ip: string; port: number; reason: string }> = [];
    for (const [id, reason] of this.authFailed) {
      const [ip, portStr] = id.split(':');
      out.push({ ip, port: Number(portStr), reason });
    }
    return out;
  }

  // Liveness snapshot for clients: when each online device was last in contact.
  //
  // Sent with the server's own clock so a client can correct for skew by
  // comparing `at` with its receipt time, rather than trusting that two
  // machines on a show network agree on the time of day.
  getHeartbeat(): { at: number; devices: Record<string, number> } {
    const devices: Record<string, number> = {};
    for (const [id, seen] of this.lastSeen) {
      const ip = id.split(':')[0];
      if (this.genuinelyOnlineIps.has(ip)) devices[id] = seen;
    }
    return { at: Date.now(), devices };
  }

  getOnlineDevices(): Array<{ ip: string; port: number }> {
    const seen = new Set<string>();
    const result: Array<{ ip: string; port: number }> = [];
    for (const [id, client] of this.clients.entries()) {
      if (!client.isConnected) continue;
      const baseId = id.replace(/-legacy$/, '');
      if (seen.has(baseId)) continue;
      seen.add(baseId);
      const colonIdx = baseId.lastIndexOf(':');
      const ip   = baseId.slice(0, colonIdx);
      const port = parseInt(baseId.slice(colonIdx + 1), 10);
      result.push({ ip, port });
    }
    return result;
  }

  // --- External Control APIs ---

  async muteChannel(deviceId: string, rxIndex: number, muted: boolean) {
    const client = this.clients.get(deviceId);
    if (!client) {
      log.warn(`[DeviceManager] Cannot mute channel, device ${deviceId} not connected.`);
      return false;
    }
    return client.setMute(rxIndex, muted);
  }

  async identifyDevice(deviceId: string) {
    const client = this.clients.get(deviceId);
    if (!client) {
      log.warn(`[DeviceManager] Cannot identify, device ${deviceId} not connected.`);
      return false;
    }
    return client.identify();
  }

  async setChannelGain(deviceId: string, rxIndex: number, gain: number) {
    const client = this.clients.get(deviceId);
    if (!client || !(client instanceof SSCClient)) {
      log.warn(`[DeviceManager] Cannot set gain, device ${deviceId} not connected or legacy.`);
      return false;
    }
    return client.setGain(rxIndex, gain);
  }

  async setChannelFrequency(deviceId: string, rxIndex: number, frequencyHz: number) {
    const client = this.clients.get(deviceId);
    // Every driver implements setFrequency; the capability is the question,
    // not the vendor. Gating on the Sennheiser client here was what stopped
    // Shure and Digital 6000 being tuned from RFDeck at all.
    if (!client || !canSet(client, 'setFrequency')) {
      log.warn(`[DeviceManager] Cannot set frequency, device ${deviceId} not connected or cannot tune.`);
      return false;
    }
    return client.setFrequency!(rxIndex, frequencyHz);
  }

  /**
   * Retune channels to a coordination plan, one at a time, and say what
   * happened to each. A channel that is not on the air or whose device
   * cannot tune is reported, not skipped silently — the operator is about
   * to trust that the rig matches the plan.
   */
  async applyFrequencyPlan(
    items: Array<{ id: string; frequencyKHz: number }>,
  ): Promise<Array<{ id: string; ok: boolean; message: string | null }>> {
    const results: Array<{ id: string; ok: boolean; message: string | null }> = [];
    for (const item of items) {
      const channel = this.channelCache.get(item.id);
      if (!channel) {
        results.push({ id: item.id, ok: false, message: 'channel is not on the air' });
        continue;
      }
      const ok = await this.setChannelFrequency(channel.deviceId, channel.channelIndex, item.frequencyKHz * 1000);
      results.push({ id: item.id, ok, message: ok ? null : 'the device refused or cannot be tuned from here' });
      log.info(
        `[coordination] ${channel.name}: ${channel.frequency} → ${item.frequencyKHz} kHz ` +
        `(${ok ? 'sent' : 'FAILED'})`,
      );
    }
    return results;
  }

  async setDeviceNetwork(deviceId: string, staticIp: string, subnet: string, gateway: string) {
    const client = this.clients.get(deviceId);
    if (!client || !(client instanceof SSCClient)) {
      log.warn(`[DeviceManager] Cannot set network, device ${deviceId} not connected or legacy.`);
      return false;
    }
    return client.setNetwork(staticIp, subnet, gateway);
  }
}




