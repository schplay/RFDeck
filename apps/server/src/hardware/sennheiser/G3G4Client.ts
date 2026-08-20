import { EventEmitter } from 'events';
import { mcpBus } from './McpBus';

// Sennheiser EW G3/G4 Media Control Protocol (MCP)
// Transport : UDP, device listens on port 53212
// Subscribe : "Push <timeout_s> <interval_ms> 3\r"
// Periodic  : \r-separated ASCII lines per packet
//   RF1 <level> <peak> <flag>   — antenna A (device scale, may exceed 100)
//   RF2 <level> <peak> <flag>   — antenna B
//   RF  <level> <count> <flag>  — aggregate (fallback if RF1/RF2 absent)
//   States <state> <state2>     — 0=OK, 3=TX_Mute (squelch, NOT user mute)
//   AF  <level> [...]           — audio 0-100 (device-native, not dBFS)
//   Bat <pct>                   — battery 0-100
//   Msg <OK|TX_Mute|...>        — human-readable status
// One-shot (explicit query, or sent once on connect):
//   Name <string>
//   Frequency <kHz> [extra...]
//
// IMPORTANT: Name and Frequency arrive in separate packets from the periodic
// status stream.  State is merged across packets so they are not lost.

const PUSH_INTERVAL_MS  = 500;   // min accepted by G3/G4 firmware; 250 returns error 1020
const PUSH_TIMEOUT_S    = 60;
const RESUB_INTERVAL_MS = 8_000;  // re-subscribe every 8s; some firmware drops subscription early in squelch/RF_Mute state
const OFFLINE_MS        = 15_000; // 15s — 30 missed 500ms packets before declaring offline

interface McpState {
  name?:      string;
  freq?:      number;  // kHz
  rfA?:       number;  // 0-100
  rfB?:       number;  // 0-100
  af?:        number;  // 0-100 (device-native)
  squelch?:   boolean; // TX squelch active (Msg TX_Mute or States 3)
  userMuted?: boolean; // user-requested mute via our app
  bat?:       number;  // 0-100
}

export class G3G4Client extends EventEmitter {
  public ip: string;
  public port: number;
  public isConnected: boolean = false;

  private resubTimer:    NodeJS.Timeout | null = null;
  private offlineTimer:  NodeJS.Timeout | null = null;
  private disconnectSignaled = false;
  private dataCount = 0;
  private msgHandler: ((raw: string) => void) | null = null;

  // Persisted state — merged across packets so one-shot fields (Name, Frequency)
  // survive the next periodic update which won't contain them.
  private state: McpState = {};

  constructor(ip: string, port: number) {
    super();
    this.ip   = ip;
    this.port = port; // inventory port (e.g. 443); actual MCP is always on McpBus port 53212
  }

  startPolling(_intervalMs?: number) {
    if (this.msgHandler) return; // already started

    this.msgHandler = (raw: string) => this.handleData(raw);
    mcpBus.addHandler(this.ip, this.msgHandler);

    console.log(`[G3G4Client] Subscribing to MCP for ${this.ip} via shared UDP :53212`);
    this.sendSubscribe();
    this.send('Name');
    this.send('Frequency');
    this.scheduleResub();
    this.resetOfflineTimer();
  }

  stopPolling() {
    this.clearTimers();
    if (this.msgHandler) {
      mcpBus.removeHandler(this.ip, this.msgHandler);
      this.msgHandler = null;
    }
    this.isConnected = false;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private sendSubscribe() { this.send(`Push ${PUSH_TIMEOUT_S} ${PUSH_INTERVAL_MS} 3`); }

  private scheduleResub() {
    this.resubTimer = setInterval(() => this.sendSubscribe(), RESUB_INTERVAL_MS);
  }

  private resetOfflineTimer() {
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    this.offlineTimer = setTimeout(() => this.handleOffline(), OFFLINE_MS);
  }

  private handleOffline() {
    this.isConnected = false;
    // Re-subscribe immediately — some firmware (especially in RF_Mute/squelch state)
    // drops the Push subscription before the PUSH_TIMEOUT_S window expires.
    this.sendSubscribe();
    if (!this.disconnectSignaled) {
      this.disconnectSignaled = true;
      console.warn(`[G3G4Client] ${this.ip}:53212 — no data for ${OFFLINE_MS / 1000}s. If the Push echo arrives but no status follows, enable "Network Control" on the device.`);
      this.emit('disconnected', 'timeout');
    }
  }

  private handleData(raw: string) {
    this.resetOfflineTimer();
    this.disconnectSignaled = false;

    // MCP error responses ("1020: Value out of range [...]") mean the device
    // is reachable but rejected the command. Don't treat as valid data.
    if (/^\d{4}:/.test(raw.trim())) {
      console.warn(`[G3G4Client] MCP error from ${this.ip}: ${raw.trim()}`);
      return;
    }

    if (!this.isConnected) {
      this.isConnected = true;
      console.log(`[G3G4Client] Connected to ${this.ip} via MCP`);
      this.emit('connected');
    }

    if (this.dataCount < 5) {
      console.log(`[G3G4Client] Packet from ${this.ip}: ${JSON.stringify(raw)}`);
    } else if (this.dataCount === 5) {
      // After 5 packets, log accumulated state to diagnose missing fields (e.g. IEM battery/RF)
      console.log(`[G3G4Client] ${this.ip} state after 5 packets — rfA:${this.state.rfA} rfB:${this.state.rfB} bat:${this.state.bat} af:${this.state.af} squelch:${this.state.squelch} name:"${this.state.name}" freq:${this.state.freq}`);
    }
    this.dataCount++;

    const updated = this.parsePacket(raw);
    if (updated) {
      Object.assign(this.state, updated);
      this.emit('state', this.buildStateTree());
    }
  }

  // Returns only the fields present in this packet; absent fields stay undefined.
  private parsePacket(raw: string): Partial<McpState> | null {
    const p: Partial<McpState> = {};

    for (const line of raw.split('\r')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;

      switch (parts[0]) {
        case 'Name':
          p.name = parts.slice(1).join(' ').trim();
          break;

        case 'Frequency': {
          const v = parseFloat(parts[1]);
          // Device sends MHz (< 1000, e.g. "512.100") or kHz (≥ 1000)
          p.freq = v < 1000 ? Math.round(v * 1000) : Math.round(v);
          break;
        }

        // Antenna-specific RF levels — values may exceed 100; clamp
        case 'RF1':
          p.rfA = Math.min(100, Math.max(0, parseInt(parts[1], 10)));
          break;
        case 'RF2':
          p.rfB = Math.min(100, Math.max(0, parseInt(parts[1], 10)));
          break;
        // Aggregate RF — only used when RF1/RF2 not present
        case 'RF':
          if (p.rfA === undefined) {
            p.rfA = Math.min(100, Math.max(0, parseInt(parts[1], 10)));
          }
          break;

        // "States <state> [state2]"
        // state = 0 → OK, state ≠ 0 (e.g. 3 = TX_Mute squelch).
        // TX squelch is stored as `squelch`, NOT as userMuted, so the mute
        // button in the UI does not flicker when RF drops briefly below squelch.
        case 'States': {
          const stateCode = parseInt(parts[1], 10);
          p.squelch = stateCode !== 0;
          break;
        }

        // "Msg OK|TX_Mute|..." — confirm squelch from text too
        case 'Msg':
          if (parts[1] === 'TX_Mute') p.squelch = true;
          else if (parts[1] === 'OK')  p.squelch = false;
          break;

        // "AF <level> [...]" — 0-100 audio level (device-native, not dBFS)
        case 'AF':
          p.af = Math.min(100, Math.max(0, parseInt(parts[1], 10)));
          break;

        case 'Bat': {
          const rawBat = parseInt(parts[1], 10);
          if (!isNaN(rawBat)) {
            // G3/G4 firmware reports transmitter/receiver battery as 0–5 bars, not 0–100.
            // Scale to percent so the dashboard shows meaningful values.
            p.bat = rawBat <= 5 ? rawBat * 20 : Math.min(100, rawBat);
          }
          // "Bat ?" means no transmitter is paired — leave p.bat undefined.
          break;
        }
      }
    }

    return Object.keys(p).length > 0 ? p : null;
  }

  // Build the full state tree from merged persistent fields.
  private buildStateTree(): Record<string, any> {
    const s = this.state;

    // AF: device sends 0-100. DeviceManager applies `100 + af_level` expecting dBFS,
    // so we shift: device 0 → -100 → DM: 0; device 100 → 0 → DM: 100.
    const afForDM = s.af !== undefined ? s.af - 100 : -100;

    return {
      rx1: {
        name:         s.name,                    // undefined → DeviceManager uses inventory name
        frequency:    s.freq   ?? 0,             // kHz
        // IEM (output) devices never send RF1/RF2 — leave undefined so DeviceManager
        // can distinguish "no RF data" from "RF is genuinely zero" for status calculation.
        rf_quality:   s.rfA,
        rf_quality_b: s.rfB ?? s.rfA,
        af_level:     afForDM,
        mute:         s.userMuted ?? false,      // only true if user pressed mute in our app
        squelch:      s.squelch ?? false,        // TX squelch (separate from user mute)
        battery:      s.bat !== undefined ? { percent: s.bat } : undefined,
      },
    };
  }

  // ── Send helpers ──────────────────────────────────────────────────────────

  private send(command: string) {
    mcpBus.sendTo(this.ip, command);
  }

  private clearTimers() {
    if (this.resubTimer)   { clearInterval(this.resubTimer);  this.resubTimer   = null; }
    if (this.offlineTimer) { clearTimeout(this.offlineTimer); this.offlineTimer = null; }
  }

  // ── Public control API ────────────────────────────────────────────────────

  async sendControl(path: string, value: any): Promise<boolean> {
    const leaf = path.split('/').pop();
    switch (leaf) {
      case 'mute': {
        this.send(`Mute ${value ? 1 : 0}`);
        // Track user-requested mute locally so the button reflects intent
        this.state.userMuted = !!value;
        this.emit('state', this.buildStateTree());
        return true;
      }
      case 'frequency':
        this.send(`Frequency ${value}`);
        return true;
      default:
        console.warn(`[G3G4Client] No MCP mapping for: ${path}`);
        return false;
    }
  }

  async identify(): Promise<boolean> { return false; }

  async setMute(rxIndex: number, muted: boolean): Promise<boolean> {
    return this.sendControl(`rx${rxIndex}/mute`, muted);
  }
}
