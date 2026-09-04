import { dbmToPercent } from '../../rfUnits';
import type { ReceiverState, DeviceStateTree } from '../../HardwareClient';

// Sennheiser Digital 6000 (EM 6000, EM 6000 Dante, L 6000) over SSC.
//
// Pure — no sockets — so the wire formats can be proved without a receiver.
//
// Source: Sennheiser's own "Sennheiser Sound Control Protocol (SSC) — Digital
// 6000" developer's guide, TI 1109 v2.2, 232 pages. Every conversion below is
// quoted from it. See docs/SENNHEISER_D6000_PROTOCOL.md.
//
// Two things about this protocol surprise anyone arriving from the EW-DX side
// of the same vendor:
//
//   The transport is the same — SSC as JSON over UDP — but the address tree is
//   almost entirely different. EW-DX has `rx1.frequency` and `m.rx1.rsqi`;
//   Digital 6000 has `rx1.carrier` and a single `mm` metering array.
//
//   Almost nothing is a percentage. RF and audio are bytes with their own
//   formulae, and the battery is a *string* from a four-value set.

/** SSC's documented default UDP port. "Sennheiser was founded in 1945." */
export const SSC_PORT = 45;

/**
 * How often the device should send metering, in milliseconds.
 *
 * The specification's own example uses min and max both 480, so that is what
 * the device is asked for rather than a number invented here.
 */
export const METER_INTERVAL_MS = 480;

/**
 * Subscription lifetime in seconds, renewed well before it expires.
 *
 * A subscription that lapses stops telemetry silently — the socket stays open
 * and the device simply goes quiet, which reads as a healthy receiver with
 * nothing to say.
 */
export const SUBSCRIPTION_LIFETIME_S = 20;

/** Renew at a third of the lifetime, so two lost datagrams are survivable. */
export const RENEW_INTERVAL_MS = (SUBSCRIPTION_LIFETIME_S * 1000) / 3;

// ── Conversions, each quoted from the specification ─────────────────────────

/**
 * RF level for one antenna, in dBm.
 *
 * "RF1/2: RF level for antenna 1/2. Value in dBm=(Value-255)/2"
 *
 * So a byte spans -127.5 to 0 dBm in half-decibel steps.
 */
export function rfByteToDbm(value: number): number {
  return (value - 255) / 2;
}

/**
 * Audio level, in dBFS.
 *
 * "AF: AF level (full scale audio level). dBFS = (Value+1)/2-128"
 *
 * Written differently from the RF formula in the specification, and
 * algebraically identical to it: (v+1)/2 - 128 expands to (v-255)/2. Kept as
 * its own function anyway, because it converts a different quantity — dBFS
 * against a full-scale audio reference, not dBm at an antenna — and a future
 * revision that changes one should not silently change the other.
 */
export function afByteToDbfs(value: number): number {
  return (value + 1) / 2 - 128;
}

/**
 * Link quality as a percentage.
 *
 * "LQI: (Audio)Link Quality Indicator. 255 means best, 0 worst."
 */
export function lqiToPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round((value / 255) * 100)));
}

/**
 * The transmitter battery gauge.
 *
 * Digital 6000 does not report a percentage. The specification gives four
 * states: `{"100%", "70%", "30%", "low"}`, and an empty array when "the
 * transmitter is not present or doesn't send valid battery information".
 *
 * The first three name their own percentage. **"low" does not**, and the value
 * below is RFDeck's choice rather than Sennheiser's: 10 is under the 20%
 * warning threshold and above the 5% critical one, so a pack the receiver
 * calls low raises a warning and not a crisis. Recorded here because it is the
 * one number on this page that is not quoted from the document.
 */
const BATTERY_STATES: Record<string, number> = {
  '100%': 100,
  '70%': 70,
  '30%': 30,
  'low': 10,
};

export interface BatteryReading {
  percent?: number;
  minutesRemaining?: number;
}

/**
 * Read `["70%", "5:12"]` — a state and a remaining time.
 *
 * An empty array means no transmitter is paired, which must stay absent rather
 * than becoming a zero: no pack is not a flat pack, and the difference is a
 * critical alert on a receiver nobody has switched a transmitter on for.
 */
export function parseBattery(value: unknown): BatteryReading | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const out: BatteryReading = {};

  const state = typeof value[0] === 'string' ? value[0].trim() : '';
  if (state in BATTERY_STATES) out.percent = BATTERY_STATES[state];

  // "Time notation: 'x:xx' or '-:--' if time information is not available."
  const time = typeof value[1] === 'string' ? value[1].trim() : '';
  const m = time.match(/^(\d+):(\d{2})$/);
  if (m) out.minutesRemaining = Number(m[1]) * 60 + Number(m[2]);

  return Object.keys(out).length > 0 ? out : null;
}

// ── The metering array ──────────────────────────────────────────────────────

/**
 * One channel's row of the `mm` array.
 *
 * "[[(RF1-ch1),(RF1-PEAK-ch1),(RF2-ch1),(RF2-PEAK-ch1),(DIV1-ch1),
 *    (DIV2-ch1),(LQI-ch1),(AF-ch1),(AF-PEAK-ch1)], [ ...ch2 ]]"
 */
export interface MeteringRow {
  /** 0–100, per antenna, via real dBm. */
  rfPercentA: number;
  rfPercentB: number;
  rfDbmA: number;
  rfDbmB: number;
  /** A digital clip in the RF section, held for at least a second. */
  rfPeakA: boolean;
  rfPeakB: boolean;
  /** Whether each diversity antenna is currently active. */
  antennaA: boolean;
  antennaB: boolean;
  /** 0–100. */
  linkQuality: number;
  /** dBFS. */
  afDbfs: number;
  afPeak: boolean;
}

const MM_ROW_LENGTH = 9;

/** Parse the `mm` value: a 2x9 array of bytes, one row per receiver channel. */
export function parseMetering(value: unknown): MeteringRow[] {
  if (!Array.isArray(value)) return [];

  const rows: MeteringRow[] = [];
  for (const raw of value) {
    // Tolerant of a short row rather than reading undefined as zero: a
    // truncated datagram must not report a dead link on a working channel.
    if (!Array.isArray(raw) || raw.length < MM_ROW_LENGTH) { rows.push(null as any); continue; }
    const n = raw.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : 0));

    const rfDbmA = rfByteToDbm(n[0]);
    const rfDbmB = rfByteToDbm(n[2]);

    rows.push({
      rfDbmA, rfDbmB,
      rfPercentA: dbmToPercent(rfDbmA),
      rfPercentB: dbmToPercent(rfDbmB),
      rfPeakA: n[1] === 1,
      rfPeakB: n[3] === 1,
      antennaA: n[4] === 1,
      antennaB: n[5] === 1,
      linkQuality: lqiToPercent(n[6]),
      afDbfs: afByteToDbfs(n[7]),
      afPeak: n[8] === 1,
    });
  }
  return rows;
}

// ── Subscriptions ───────────────────────────────────────────────────────────

/**
 * What RFDeck asks an EM 6000 to keep it informed about.
 *
 * Two subscriptions rather than one: the metering array wants a fixed fast
 * rate, and everything else should arrive when it changes. Asking for the
 * channel tree at 480 ms would be a datagram of names and frequencies twice a
 * second for values that move only when an operator touches something.
 */
export function subscriptionMessages(channels: number[]): string[] {
  const meter = {
    osc: { state: { subscribe: [{
      // The specification's own example for this node, values and all.
      '#': { min: METER_INTERVAL_MS, max: METER_INTERVAL_MS, lifetime: SUBSCRIPTION_LIFETIME_S, count: 1000 },
      mm: null,
    }] } },
  };

  const rx: Record<string, unknown> = {};
  for (const ch of channels) {
    rx[`rx${ch}`] = {
      name: null,
      carrier: null,
      audio_mute: null,
      active_warnings: null,
      // The transmitter's own reported state, which lives under skx.
      skx: { battery: null, name: null, type: null },
    };
  }

  const state = {
    osc: { state: { subscribe: [{
      '#': { lifetime: SUBSCRIPTION_LIFETIME_S, count: 1000 },
      ...rx,
    }] } },
  };

  return [JSON.stringify(meter), JSON.stringify(state)];
}

/** The one-off questions asked on connect, for values that are not subscribable. */
export function identityMessages(): string[] {
  return [JSON.stringify({
    device: { identity: { version: null, vendor: null, product: null }, name: null },
  })];
}

// ── Turning a datagram into RFDeck's channel shape ──────────────────────────

/**
 * Fold one SSC message into a partial state tree.
 *
 * Returns only what the message actually carried, so a caller can merge it
 * over what it already knows. A metering datagram says nothing about names,
 * and must not blank them.
 */
export function applyMessage(json: any, channels: number[]): DeviceStateTree {
  const tree: DeviceStateTree = {};
  if (!json || typeof json !== 'object') return tree;

  const at = (ch: number): ReceiverState => {
    const key = `rx${ch}`;
    if (!tree[key]) tree[key] = {};
    return tree[key]!;
  };

  // The metering array is positional: row 0 is channel 1.
  if (json.mm !== undefined) {
    const rows = parseMetering(json.mm);
    rows.forEach((row, index) => {
      if (!row) return;
      const s = at(index + 1);
      s.rf_quality = row.rfPercentA;
      s.rf_quality_b = row.rfPercentB;
      s.af_level = row.afDbfs;
    });
  }

  for (const ch of channels) {
    const block = json[`rx${ch}`];
    if (!block || typeof block !== 'object') continue;
    const s = at(ch);

    if (typeof block.name === 'string') s.name = block.name;
    // "sets or returns the carrier Frequency in kHz" — RFDeck's unit already.
    if (typeof block.carrier === 'number') s.frequency = block.carrier;
    if (typeof block.audio_mute === 'boolean') s.mute = block.audio_mute;

    if (block.skx && typeof block.skx === 'object') {
      if (block.skx.battery !== undefined) {
        const battery = parseBattery(block.skx.battery);
        // Absent stays absent: no transmitter paired is not a flat one.
        if (battery) s.battery = battery;
      }
      // The transmitter's own name, used only when the channel has none.
      if (typeof block.skx.name === 'string' && !s.name) s.name = block.skx.name;
    }

    // "Warnings: {RFPeak, AFPeak, LowSignal, NoLink, LowBattery, ...}"
    //
    // NoLink is the one that maps onto something RFDeck already models: the
    // transmitter is off or out of range, which is a squelch rather than an
    // operator's mute.
    if (Array.isArray(block.active_warnings)) {
      s.squelch = block.active_warnings.includes('NoLink');
    }
  }

  return tree;
}

/** Does this model string name a Digital 6000 device? */
export function isDigital6000(model: string): boolean {
  return /\bEM\s?6000\b|\bL\s?6000\b|digital\s?6000/i.test((model ?? '').trim());
}
