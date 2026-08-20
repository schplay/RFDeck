import crypto from 'crypto';
import { DiscoveryService, DiscoveredDevice } from './DiscoveryService';
import { SSCClient } from './SSCClient';
import { G3G4Client } from './G3G4Client';
import { EventEmitter } from 'events';
import { Server } from 'socket.io';
import { Device, Channel } from '@rfdeck/shared-types';
import { prisma } from '../../db';
import { getMacByIp } from '../../utils/arp';
import {
  evaluateSample, confirmDropout, DEFAULT_RF_THRESHOLDS,
  RfState, RfThresholds,
} from '../rfState';
import {
  addSample, estimate as estimateBattery,
  BatterySample, BatteryEstimate,
} from '../batteryEstimator';

type ClientType = SSCClient | G3G4Client;

export class DeviceManagerService extends EventEmitter {
  private discovery: DiscoveryService;
  private io: Server;
  private clients: Map<string, ClientType> = new Map();
  private channelCache: Map<string, Channel> = new Map();
  private deviceNames: Map<string, string> = new Map(); // base id → user-assigned name
  private discoveredCache: Map<string, any> = new Map(); // key → discovered device payload
  // IPs that have had at least one successful connection — used to distinguish
  // a real "went offline" from an initial SSCv2 probe failure before G3/G4 fallback.
  private genuinelyOnlineIps = new Set<string>();
  // Pending device:lost timers — cancelled if the device reconnects within the grace period.
  // This prevents brief SSE drops / network hiccups from causing visible offline flashes.
  private lostTimers = new Map<string, NodeJS.Timeout>();
  private readonly LOST_DEBOUNCE_MS = 2000;
  // Debounce: avoid triggering multiple scans in quick succession when several
  // devices drop at once (e.g. network switch reboot).
  private lastAutoScanAt = 0;
  private readonly AUTO_SCAN_COOLDOWN_MS = 20_000;
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
    this.discovery = new DiscoveryService();

    this.discovery.on('discovered', (device: DiscoveredDevice) => {
      this.handleDiscovered(device);
    });

    // After every scan, re-attempt reconciliation for devices that were discovered
    // but never matched to inventory.  Without this, a failed first reconcile
    // (e.g. ARP race) leaves the IP in seenIps and it is never retried — the
    // device stays "discovered" forever while its inventory entry stays offline.
    this.discovery.on('scan:complete', () => {
      this.reconcileUntrackedDiscoveries().catch(() => {});
    });
  }

  private async reconcileUntrackedDiscoveries(): Promise<void> {
    for (const device of this.discoveredCache.values()) {
      const id = `${device.ip}:${device.port}`;
      if (this.clients.has(id) || this.clients.has(`${id}-legacy`)) continue;
      await this.tryAutoReconcile(device.ip, device.port).catch(() => {});
    }
  }

  async start() {
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
        console.log(`[DeviceManager] Skipping inactive device "${dev.name}" (${dev.ip})`);
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
    const startupScan = () => this.discovery.scan().catch(() => {});
    setTimeout(startupScan, 2_000);
    setTimeout(startupScan, 30_000);
    setTimeout(startupScan, 75_000);
  }

  stop() {
    this.discovery.stop();
    for (const client of this.clients.values()) {
      client.stopPolling();
    }
  }

  // Called via REST API when user adds a device
  public trackDevice(device: { ip: string; port: number; name?: string }) {
    const id = `${device.ip}:${device.port}`;
    console.log(`[DeviceManager] trackDevice called for ${device.name ?? id} at ${id}`);
    if (this.clients.has(id)) {
      console.log(`[DeviceManager] Already tracking ${id}, skipping`);
      return;
    }

    // Store user-assigned name for use in channel labels
    if (device.name) this.deviceNames.set(id, device.name);

    // First try SSCv2 (HTTPS), passing password if one is stored
    const client = new SSCClient(device.ip, device.port, (device as any).password ?? null);
    this.setupClientListeners(client, device.ip, device.port, id);

    client.on('disconnected', () => {
      // If SSCv2 fails, immediately stop it and fall back to G3/G4 MCP.
      // Don't keep SSCClient probing while G3G4Client is running — it floods the log.
      if (!this.clients.get(`${id}-legacy`)) {
        const ssc = this.clients.get(id);
        if (ssc instanceof SSCClient) {
          ssc.stopPolling();
        }
        console.log(`[DeviceManager] SSCv2 failed for ${device.ip}, falling back to G3/G4 MCP`);
        const legacyClient = new G3G4Client(device.ip, device.port);
        this.clients.set(`${id}-legacy`, legacyClient);
        this.setupClientListeners(legacyClient, device.ip, device.port, `${id}-legacy`);
        legacyClient.startPolling();
      }
    });

    this.clients.set(id, client);
    client.startPolling(250);
  }

  public updateTrackedDevice(device: { ip: string; port: number; active?: boolean }) {
    this.untrackDevice(device.ip, device.port);
    if (device.active === false) return; // inactive devices are never tracked
    this.trackDevice(device);
  }

  // Operator marked a device active/inactive.  Inactive devices are fully
  // untracked: no polling, no telemetry, no dropout or battery alerts, and their
  // channel strips are removed from the dashboard.
  public setDeviceActive(
    device: { ip: string; port: number; name?: string; password?: string | null },
    active: boolean,
  ) {
    const id = `${device.ip}:${device.port}`;
    if (active) {
      console.log(`[DeviceManager] Activating "${device.name ?? id}" — resuming tracking`);
      this.trackDevice(device);
    } else {
      console.log(`[DeviceManager] Deactivating "${device.name ?? id}" — stopping tracking`);
      // Cancel any pending dropout timers for this device's channels so a
      // deactivation mid-dropout can't fire an alert after the fact.
      for (const [channelId, timer] of this.pendingDropouts) {
        if (channelId.startsWith(id)) {
          clearTimeout(timer);
          this.pendingDropouts.delete(channelId);
        }
      }
      this.untrackDevice(device.ip, device.port);
    }
  }

  public untrackDevice(ip: string, port: number) {
    const id = `${ip}:${port}`;
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
    for (const key of [...this.rfStates.keys()]) {
      if (key.startsWith(id)) this.rfStates.delete(key);
    }
    for (const [key, timer] of this.pendingDropouts) {
      if (key.startsWith(id)) { clearTimeout(timer); this.pendingDropouts.delete(key); }
    }
    // Discard battery history — a device that comes back after being off has a
    // discontinuous curve, and projecting across the gap would be wrong.
    for (const key of [...this.batteryHistory.keys()]) {
      if (key.startsWith(id)) {
        this.batteryHistory.delete(key);
        this.batteryEstimates.delete(key);
        this.lastBatterySampleAt.delete(key);
      }
    }
    this.genuinelyOnlineIps.delete(ip);
    const pendingLost = this.lostTimers.get(ip);
    if (pendingLost) { clearTimeout(pendingLost); this.lostTimers.delete(ip); }
    // Allow the device to be re-discovered (clears seenIps in DiscoveryService)
    this.discovery.forgetDevice(ip, port);
    this.discovery.forgetDevice(ip, 53212); // also clear MCP port for G3/G4 devices
    // Release any secondary (Dante) IPs owned by this device
    for (const [sIp, owner] of this.secondaryIps) {
      if (owner === ip) this.secondaryIps.delete(sIp);
    }
    // Tell the frontend to remove channel strips for this device
    this.io.emit('device:untracked', { ip, port });
  }

  private setupClientListeners(client: ClientType, ip: string, port: number, id: string) {
    client.on('state', (stateTree: any) => {
      this.normalizeAndEmit(id, stateTree);
    });

    client.on('connected', async () => {
      console.log(`[DeviceManager] Connected to ${ip} via ${client instanceof SSCClient ? 'SSCv2' : 'G3/G4'}`);
      // Cancel any pending lost timer — device reconnected within the grace period
      const pendingLost = this.lostTimers.get(ip);
      if (pendingLost) {
        clearTimeout(pendingLost);
        this.lostTimers.delete(ip);
      }
      this.genuinelyOnlineIps.add(ip);
      this.emit('device:online', { ip, port });

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
          // Store the MAC on the inventory row so future lookups work
          await prisma.inventoryDevice.updateMany({
            where: { ip, mac: null },
            data: { mac },
          });
          await this.reconcileByMac(mac, ip, port);
        }
      }
    });

    client.on('disconnected', (err: any) => {
      console.log(`[DeviceManager] Disconnected from ${ip} — ${err}`);
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
          this.maybeAutoScan();
        }, this.LOST_DEBOUNCE_MS);
        this.lostTimers.set(ip, timer);
      }
    });

    // SSCv2 only: forward device identity metadata to the frontend and reconcile by MAC
    if (client instanceof SSCClient) {
      client.on('metadata', async (meta: any) => {
        // Persist identity fields so they survive server restarts
        const patch: Record<string, string> = {};
        if (meta.mac)      patch.mac      = meta.mac;
        if (meta.serial)   patch.serial   = meta.serial;
        if (meta.firmware) patch.firmware = meta.firmware;
        if (Object.keys(patch).length > 0) {
          await prisma.inventoryDevice.updateMany({
            where: { ip },
            data: patch,
          });
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
    console.log(
      `[DeviceManager] MAC ${mac} moved: ${oldIp} → ${currentIp} ` +
      `(device: "${stale.name}"). Updating inventory.`,
    );

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

  private clearChannelsForDevice(deviceId: string) {
    const baseId = deviceId.replace(/-legacy$/, '');
    const toDelete: string[] = [];
    for (const channelId of this.channelCache.keys()) {
      if (channelId.startsWith(baseId)) toDelete.push(channelId);
    }
    for (const channelId of toDelete) {
      this.channelCache.delete(channelId);
    }
  }

  // Query a connected SSC device for its network config and register its
  // secondary (Dante) addresses so discovery never shows them as new devices.
  private async registerSecondaryIps(client: SSCClient, ip: string, port: number): Promise<void> {
    const net = await SSCClient.fetchNetworkAddresses(ip, port, client.getPassword());
    if (!net) return;

    // Prefer address-named keys; fall back to all IPv4s in the Dante payload
    // minus obvious non-host values (netmasks, unconfigured 0.0.0.0).
    const candidates = net.danteAddrs.length > 0 ? net.danteAddrs : net.danteAll;
    const secondaries = candidates.filter(a =>
      a !== ip && a !== '0.0.0.0' && !a.startsWith('255.') && !a.startsWith('127.')
    );

    for (const sIp of secondaries) {
      if (this.secondaryIps.get(sIp) !== ip) {
        console.log(`[DeviceManager] ${ip}: secondary (Dante) IP ${sIp} registered — suppressed from discovery`);
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
      console.log(`[DeviceManager] Discovery hit on ${device.ip} — known secondary of ${this.secondaryIps.get(device.ip)}, suppressing`);
      this.suppressDiscovered(device.ip, device.port);
      return;
    }
    this.discoveredCache.set(`${device.ip}:${device.port}`, device);
    this.emit('device:discovered', device);
    // If this IP isn't already tracked, check whether it's a known inventory
    // device that changed IP (e.g. DHCP re-assignment after power cycle).
    this.tryAutoReconcile(device.ip, device.port)
      .then(() => {
        // If the first attempt failed (e.g. ARP cache not yet populated on Windows),
        // schedule a retry after 3s without going through the seenIps-gated discovery
        // path again.  The retry is a no-op if the device was already reconciled.
        const tracked = this.clients.has(`${device.ip}:${device.port}`) ||
                        this.clients.has(`${device.ip}:${device.port}-legacy`);
        if (!tracked) {
          setTimeout(() => {
            this.tryAutoReconcile(device.ip, device.port).catch(() => {});
          }, 3_000);
        }
      })
      .catch(() => {});
  }

  // Probe a newly-discovered IP against offline inventory devices to detect
  // IP changes without requiring the user to manually edit the inventory.
  private async tryAutoReconcile(ip: string, port: number): Promise<void> {
    if (this.clients.has(`${ip}:${port}`)) return; // already tracked

    if (port === 443) {
      // SSC device: probe the discovered IP's /api/device/identity with each
      // known inventory password until one works, then match by MAC/serial.
      const inventory = await prisma.inventoryDevice.findMany({ where: { port, active: true } });
      const passwords = [...new Set(inventory.map(d => d.password ?? null))];

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
            console.log(`[DeviceManager] ${ip} is the control interface of "${known.name}" (record had ${known.ip}) — migrating`);
            await this.migrateDeviceIp(known, ip, port);
            return;
          }
          if (net.danteAll.includes(ip)) {
            // Secondary (Dante) interface. If the inventory record itself is sitting
            // on a non-control IP (earlier mis-migration), heal it using the control
            // address the device just reported.
            const trueControl = net.controlAddrs.find(a => a !== ip);
            if (trueControl && known.ip !== trueControl) {
              console.log(`[DeviceManager] Healing "${known.name}": record at ${known.ip}, device reports control IP ${trueControl}`);
              await this.migrateDeviceIp(known, trueControl, port);
            }
            console.log(`[DeviceManager] ${ip} is the Dante interface of "${known.name}" — suppressing`);
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
          console.log(`[DeviceManager] ${ip} has different MAC than "${known.name}" control NIC — secondary interface, suppressing`);
          this.suppressDiscovered(ip, port);
          return;
        }

        // Fallback 2: reachability. Never steal the record from a live connection,
        // and never migrate while the recorded IP still answers with the same serial.
        if (this.clients.get(`${known.ip}:${known.port}`)?.isConnected) {
          console.log(`[DeviceManager] ${ip} matches connected "${known.name}" (${known.ip}) — suppressing`);
          this.suppressDiscovered(ip, port);
          return;
        }
        const atOldIp = await SSCClient.fetchIdentity(known.ip, known.port, password);
        if (atOldIp?.serial && atOldIp.serial === identity.serial) {
          console.log(`[DeviceManager] "${known.name}" still answers at ${known.ip}; ${ip} is its secondary interface — suppressing`);
          this.suppressDiscovered(ip, port);
          return;
        }

        console.log(`[DeviceManager] Auto-reconnect: "${known.name}" found at new IP ${ip} (was ${known.ip})`);
        await this.migrateDeviceIp(known, ip, port);
        return;
      }
    } else if (port === 53212) {
      // G3/G4 MCP device: ARP cache is populated once we send a UDP probe to this IP.
      // On Windows, the cache entry can take a moment to appear — retry a few times.
      let mac: string | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        mac = await getMacByIp(ip);
        if (mac) break;
        await new Promise<void>(r => setTimeout(r, 400));
      }
      if (!mac) {
        console.log(`[DeviceManager] tryAutoReconcile: ARP miss for ${ip} after retries — cannot reconcile`);
        return;
      }

      // Store MAC against any inventory record that already sits at this IP but
      // hasn't had its MAC recorded yet (e.g. device added manually then reconnected).
      await prisma.inventoryDevice.updateMany({ where: { ip, mac: null }, data: { mac } });

      const stale = await prisma.inventoryDevice.findFirst({
        where: { mac, active: true, NOT: { ip } },
      });
      if (!stale) {
        console.log(`[DeviceManager] tryAutoReconcile: no offline record with mac=${mac} at a different IP`);
        return;
      }
      if (this.clients.get(`${stale.ip}:${stale.port}`)?.isConnected) {
        console.log(`[DeviceManager] tryAutoReconcile: old client at ${stale.ip}:${stale.port} still connected`);
        return;
      }

      console.log(`[DeviceManager] Auto-reconnect: G3/G4 "${stale.name}" found at new IP ${ip} (was ${stale.ip})`);
      await this.migrateDeviceIp(stale, ip, port);
    }
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
  }

  // Remove a discovered entry that turned out to be a secondary interface of an
  // already-tracked device (e.g. the Dante NIC of a connected EW-DX).
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

        const channelId = `${deviceId}-${rx}`;

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
        const fallbackName = channelCount > 1
          ? `${deviceLabel} CH${index + 1}`
          : deviceLabel;

        // isMuted = user-requested mute only (not TX squelch)
        const isMuted = rxData.mute === true;
        // squelch = transmitter below threshold (TX_Mute from device)
        const isSquelch = rxData.squelch === true;
        const status = isMuted ? 'WARNING'
                     : (rfKnown && rfA < 20) ? 'CRITICAL'
                     : isSquelch ? 'WARNING'
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
          gain: Number.isFinite(rawGain) ? rawGain : 0,
          status,
        };


        // Check if anything changed
        const oldChannel = this.channelCache.get(channelId);
        if (JSON.stringify(oldChannel) !== JSON.stringify(newChannel)) {
          this.channelCache.set(channelId, newChannel);
          this.io.emit('channel:telemetry', newChannel);

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
              if (oldBatt > 20 && newBatt <= 20 && newBatt > 5) {
                this.emitAlert({
                  severity: 'WARNING',
                  type: 'LOW_BATTERY',
                  message: `Battery low (${newBatt}%)`,
                  channelId,
                  channelName: newChannel.name,
                  deviceId
                });
              } else if (oldBatt > 5 && newBatt <= 5) {
                this.emitAlert({
                  severity: 'CRITICAL',
                  type: 'CRITICAL_BATTERY',
                  message: `Battery critical (${newBatt}%)`,
                  channelId,
                  channelName: newChannel.name,
                  deviceId
                });
              }
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
        channelKey: channel.name,
        channelName: channel.name,
        deviceId,
        rfLevelA: Math.round(channel.rfLevelA),
        rfLevelB: Math.round(channel.rfLevelB),
      },
    }).catch(err => console.warn('[DeviceManager] Could not persist RF event:', err?.message));
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
      console.log(`[DeviceManager] Pruned ${byAge.count + byCount} old event(s)`);
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
    await this.discovery.scan();
  }

  get isScanInProgress(): boolean {
    return this.discovery.isScanning;
  }

  // Auto-triggered when a device goes offline; debounced to avoid hammering
  // the network when several devices drop at the same time.
  private maybeAutoScan() {
    const now = Date.now();
    if (now - this.lastAutoScanAt < this.AUTO_SCAN_COOLDOWN_MS) return;
    this.lastAutoScanAt = now;
    console.log('[DeviceManager] Device went offline — triggering discovery scan (cooldown: 60s)');
    this.discovery.scan().catch(() => {});
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

    prisma.event.create({
      data: {
        id: alert.id,
        timestamp: new Date(alert.timestamp),
        source: 'ALERT',
        type: String(params.type),
        severity: String(params.severity),
        message: params.message,
        channelKey: params.channelName ?? null,
        channelName: params.channelName ?? null,
        deviceId: params.deviceId ?? null,
      },
    }).catch(err => console.warn('[DeviceManager] Could not persist alert:', err?.message));
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

  getChannelSnapshot(): Channel[] {
    return Array.from(this.channelCache.values());
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
      console.warn(`[DeviceManager] Cannot mute channel, device ${deviceId} not connected.`);
      return false;
    }
    return client.setMute(rxIndex, muted);
  }

  async identifyDevice(deviceId: string) {
    const client = this.clients.get(deviceId);
    if (!client) {
      console.warn(`[DeviceManager] Cannot identify, device ${deviceId} not connected.`);
      return false;
    }
    return client.identify();
  }

  async setChannelGain(deviceId: string, rxIndex: number, gain: number) {
    const client = this.clients.get(deviceId);
    if (!client || !(client instanceof SSCClient)) {
      console.warn(`[DeviceManager] Cannot set gain, device ${deviceId} not connected or legacy.`);
      return false;
    }
    return client.setGain(rxIndex, gain);
  }

  async setChannelFrequency(deviceId: string, rxIndex: number, frequencyHz: number) {
    const client = this.clients.get(deviceId);
    if (!client || !(client instanceof SSCClient)) {
      console.warn(`[DeviceManager] Cannot set frequency, device ${deviceId} not connected or legacy.`);
      return false;
    }
    return client.setFrequency(rxIndex, frequencyHz);
  }

  async setDeviceNetwork(deviceId: string, staticIp: string, subnet: string, gateway: string) {
    const client = this.clients.get(deviceId);
    if (!client || !(client instanceof SSCClient)) {
      console.warn(`[DeviceManager] Cannot set network, device ${deviceId} not connected or legacy.`);
      return false;
    }
    return client.setNetwork(staticIp, subnet, gateway);
  }
}




