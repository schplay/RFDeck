// Shure command strings: framing, parsing, and the conversions into RFDeck's
// units. Pure — no sockets, no state — because there is no Shure hardware on
// the development machine and this is the part that can be proved correct
// without any.
//
// See docs/SHURE_PROTOCOL.md for the sources. Every format and range here was
// read out of Shure's own "Axient Digital — Command Strings" document or, for
// the ULX-D/QLX-D names it does not cover, out of a working implementation
// (micboard). Nothing is from memory.

/**
 * Which command vocabulary a receiver speaks.
 *
 * Not cosmetic: Axient calls the battery gauge TX_BATT_BARS and ULX-D calls it
 * BATT_BARS. Asking for the wrong one fails silently — a GET for a parameter
 * the device does not have simply never produces a REP — so a single merged
 * command set would look like a dead device rather than a bug.
 */
export type ShureFamily = 'axtd' | 'ulxd' | 'qlxd';

export interface FamilySpec {
  family: ShureFamily;
  label: string;
  /** Parameter names, by what RFDeck wants rather than what Shure calls it. */
  param: {
    channelName: string;
    frequency: string;
    battBars: string;
    battMins: string;
    rfLevel: string;
    audioLevel: string;
    antenna: string;
    mute: string;
    /** Link quality, which only Axient reports. */
    quality?: string;
  };
  /** Highest channel index this family's receivers can have. */
  maxChannels: number;
}

export const FAMILIES: Record<ShureFamily, FamilySpec> = {
  axtd: {
    family: 'axtd',
    label: 'Axient Digital',
    param: {
      channelName: 'CHAN_NAME',
      frequency:   'FREQUENCY',
      battBars:    'TX_BATT_BARS',
      battMins:    'TX_BATT_MINS',
      rfLevel:     'RSSI',
      audioLevel:  'AUDIO_LEVEL_RMS',
      antenna:     'ANTENNA_STATUS',
      mute:        'AUDIO_MUTE',
      quality:     'CHAN_QUALITY',
    },
    maxChannels: 4,
  },
  ulxd: {
    family: 'ulxd',
    label: 'ULX-D',
    param: {
      channelName: 'CHAN_NAME',
      frequency:   'FREQUENCY',
      battBars:    'BATT_BARS',
      battMins:    'BATT_RUN_TIME',
      rfLevel:     'RX_RF_LVL',
      audioLevel:  'AUDIO_LVL',
      antenna:     'RF_ANTENNA',
      mute:        'AUDIO_MUTE',
    },
    maxChannels: 4,
  },
  qlxd: {
    family: 'qlxd',
    label: 'QLX-D',
    param: {
      channelName: 'CHAN_NAME',
      frequency:   'FREQUENCY',
      battBars:    'BATT_BARS',
      battMins:    'BATT_RUN_TIME',
      rfLevel:     'RX_RF_LVL',
      audioLevel:  'AUDIO_LVL',
      antenna:     'RF_ANTENNA',
      mute:        'AUDIO_MUTE',
    },
    maxChannels: 1,
  },
};

/** Channel count per model, so the client knows how many channels to ask about. */
const MODEL_CHANNELS: Array<{ match: RegExp; family: ShureFamily; channels: number }> = [
  { match: /AD4Q/i,                      family: 'axtd', channels: 4 },
  { match: /AD4D/i,                      family: 'axtd', channels: 2 },
  { match: /ULX-?D.*Quad|ULXD4Q/i,       family: 'ulxd', channels: 4 },
  { match: /ULX-?D.*Dual|ULXD4D/i,       family: 'ulxd', channels: 2 },
  { match: /ULX-?D.*Single|ULXD4(?!\w)/i, family: 'ulxd', channels: 1 },
  { match: /QLX-?D/i,                    family: 'qlxd', channels: 1 },
];

/**
 * What family and how many channels, from a model string.
 *
 * Returns null rather than a guess when the model is unrecognised: opening the
 * wrong number of channels means either missing half a receiver or asking a
 * two-channel box about channels 3 and 4 forever.
 */
export function identifyModel(model: string): { family: ShureFamily; channels: number } | null {
  const m = (model ?? '').trim();
  if (!m) return null;
  for (const entry of MODEL_CHANNELS) {
    if (entry.match.test(m)) return { family: entry.family, channels: entry.channels };
  }
  return null;
}

// ── Framing ─────────────────────────────────────────────────────────────────

/**
 * Split a TCP read into complete `< ... >` messages, keeping any partial tail.
 *
 * Shure sends no line breaks, several messages arrive in one segment, and a
 * segment can end mid-message. Splitting on newlines finds nothing; splitting
 * on '>' and discarding the tail drops whichever message straddled the
 * boundary — usually a metering sample, so the symptom is a meter that
 * stutters rather than an obvious fault.
 */
export function splitMessages(buffer: string): { messages: string[]; remainder: string } {
  const messages: string[] = [];
  let rest = buffer;

  for (;;) {
    const end = rest.indexOf('>');
    if (end === -1) break;

    const start = rest.lastIndexOf('<', end);
    // A '>' with no '<' before it is noise from a resynchronised stream; drop
    // it rather than carrying it forever.
    if (start !== -1) messages.push(rest.slice(start, end + 1));
    rest = rest.slice(end + 1);
  }

  // Never carry an unbounded tail: a device that sends '<' and then goes quiet
  // would otherwise grow this string until the process dies.
  if (rest.length > 4096) rest = rest.slice(-1024);

  return { messages, remainder: rest };
}

export interface ShureMessage {
  /** REP, SAMPLE, or whatever else arrived. */
  type: string;
  /** Channel index, or null for a device-level message. */
  channel: number | null;
  /** The parameter name — CHAN_NAME, RSSI, ALL for a sample. */
  param: string;
  /** Remaining fields, braces stripped from any {padded string}. */
  args: string[];
  /** Fields with the braced value joined, for parameters whose value has spaces. */
  value: string;
}

/**
 * Parse one `< ... >` message.
 *
 * Braced values are the awkward part: `{Lead Vox            }` is one value
 * containing a space and a lot of padding, and splitting on whitespace turns a
 * channel called "Lead Vox" into "Lead". The braces are found first and their
 * contents kept whole.
 */
export function parseMessage(raw: string): ShureMessage | null {
  const trimmed = raw.trim().replace(/^</, '').replace(/>$/, '').trim();
  if (!trimmed) return null;

  // Pull out a braced value before tokenising, so its spaces survive.
  let braced: string | null = null;
  let head = trimmed;
  const open = trimmed.indexOf('{');
  if (open !== -1) {
    const close = trimmed.indexOf('}', open);
    if (close !== -1) {
      braced = trimmed.slice(open + 1, close);
      head = (trimmed.slice(0, open) + ' ' + trimmed.slice(close + 1)).trim();
    }
  }

  const tokens = head.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const type = tokens[0];
  let index = 1;
  let channel: number | null = null;

  // A numeric second token is a channel index. Device-level messages go
  // straight to the parameter name: "< REP DEVICE_ID {...} >".
  if (/^\d+$/.test(tokens[1] ?? '')) {
    channel = Number(tokens[1]);
    index = 2;
  }

  const param = tokens[index] ?? '';
  const rest = tokens.slice(index + 1);
  const args = braced !== null ? [...rest, braced] : rest;

  return {
    type,
    channel,
    param,
    args,
    // Braced values keep their padding on the wire; nothing above wants it.
    value: braced !== null ? braced.trim() : rest.join(' '),
  };
}

// ── Values ──────────────────────────────────────────────────────────────────

/**
 * Shure reports RF and audio as an offset integer: actual = reported - 120.
 * RSSI is then dBm and audio is dBFS.
 */
export const SHURE_DB_OFFSET = 120;

/** 255 means "unknown" for the 3-digit gauges, and is not a value. */
const UNKNOWN_3 = 255;

/**
 * Number(), minus JavaScript's worst default.
 *
 * `Number('')` and `Number('   ')` are 0, not NaN — so a field the device left
 * blank arrives as a real reading. For audio that is -120 dBFS, indistinguish-
 * able from a dead microphone; for RF it is 0%, which raises a dropout alert
 * for a channel nobody has touched. An absent value must stay absent.
 */
function num(raw: string | number | undefined | null): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (raw === undefined || raw === null) return null;
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * TX_BATT_MINS sentinels. Taken at face value 65535 is a transmitter with
 * forty-five years of runtime, and it passes any check that only rejects
 * negatives.
 */
const BATT_MINS_MAX = 65532;

export function parseBatteryBars(raw: string): number | null {
  const n = num(raw);
  if (n === null || n === UNKNOWN_3) return null;
  return n >= 0 && n <= 5 ? n : null;
}

/**
 * Battery as a percentage, from a five-bar gauge.
 *
 * Coarse on purpose — 0, 20, 40, 60, 80, 100 — because that is genuinely all
 * the protocol carries. Axient reports no battery percentage.
 */
export function batteryBarsToPercent(bars: number | null): number | undefined {
  return bars === null ? undefined : bars * 20;
}

/** Runtime in minutes, or null for unknown / calculating / comms warning. */
export function parseBatteryMinutes(raw: string): number | null {
  const n = num(raw);
  if (n === null) return null;
  return n >= 0 && n <= BATT_MINS_MAX ? n : null;
}

/** dBm from a reported RSSI field. */
export function rssiToDbm(raw: string | number): number | null {
  const n = num(raw);
  return n === null ? null : n - SHURE_DB_OFFSET;
}

/**
 * RF as the 0–100 RFDeck shows on a meter.
 *
 * 115 is the span micboard uses, putting 0% at -120 dBm and 100% at -5 dBm.
 * What matters is where it leaves RFDeck's existing thresholds: CRITICAL below
 * 20 is -97 dBm and marginal below 35 is -80 dBm, both sensible for a mic link.
 */
export function rssiToPercent(raw: string | number): number | null {
  const n = num(raw);
  if (n === null) return null;
  return clamp(Math.round((100 * n) / 115), 0, 100);
}

/**
 * Audio level as dBFS, which is what DeviceManagerService expects on
 * `af_level` — it applies `100 + dBFS` itself, the same as for Sennheiser.
 */
export function audioToDbfs(raw: string | number, family: ShureFamily): number | null {
  const n = num(raw);
  if (n === null) return null;

  // ULX-D and QLX-D report a 0–50ish meter value rather than an offset dBFS
  // one; micboard doubles it to get a percentage. Converted back to the dBFS
  // this function promises, that is `2n - 100`.
  if (family === 'ulxd' || family === 'qlxd') return clamp(2 * n, 0, 100) - 100;

  return n - SHURE_DB_OFFSET;
}

/** Frequency in kHz. Shure reports kHz already, which is RFDeck's unit too. */
export function parseFrequencyKhz(raw: string): number {
  const n = num(raw);
  return n !== null && n > 0 ? n : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ── Metering samples ────────────────────────────────────────────────────────

export interface SampleReading {
  channel: number;
  /** 0–5 link quality, or null where the family does not report it. */
  quality: number | null;
  /** dBFS. */
  audioDbfs: number | null;
  /** 0–100 per antenna, in A B C D order — two entries, or four on Quadversity. */
  rfPercent: number[];
  /** Per antenna: 'X' off, 'R' red, 'B' blue. */
  antennas: string[];
}

/**
 * Read a periodic SAMPLE.
 *
 * The layout is not fixed. Axient appends a second RF section for frequency
 * diversity and doubles the antennas for Quadversity, so a parser using
 * hardcoded indices for anything past the first two antennas silently reads
 * the wrong fields on a rig configured either way:
 *
 *   < SAMPLE 1 ALL 005 031 102 102 BB   31 086 31 065 >
 *   < SAMPLE 1 ALL 005 031 102 102 BBBB 31 083 31 068 31 069 31 072 >
 *
 * The antenna-status field says how many antennas follow — one character each
 * — so the count is read rather than assumed.
 */
export function parseSample(msg: ShureMessage, family: ShureFamily): SampleReading | null {
  if (msg.type !== 'SAMPLE' || msg.channel === null) return null;

  const f = msg.args;

  if (family === 'ulxd' || family === 'qlxd') {
    // < SAMPLE 1 ALL antenna rf audio >  — args after ALL.
    const [antenna, rf, audio] = f;
    if (antenna === undefined) return null;
    return {
      channel: msg.channel,
      quality: null,
      audioDbfs: audio !== undefined ? audioToDbfs(audio, family) : null,
      rfPercent: rf !== undefined ? [rssiToPercent(rf) ?? 0] : [],
      antennas: splitAntennas(antenna),
    };
  }

  // Axient: qual audBitmap audPeak audRms antStats [bitmap rssi] x N ...
  const [qual, , , audRms, antStats, ...rfFields] = f;
  if (antStats === undefined) return null;

  const antennas = splitAntennas(antStats);
  const rfPercent: number[] = [];
  // Antenna readings come in (bitmap, rssi) pairs, one pair per antenna
  // character. Anything beyond that belongs to a second frequency-diversity
  // section, which RFDeck does not surface as extra antennas.
  for (let i = 0; i < antennas.length; i++) {
    const rssi = rfFields[i * 2 + 1];
    if (rssi === undefined) break;
    rfPercent.push(rssiToPercent(rssi) ?? 0);
  }

  const q = num(qual);
  return {
    channel: msg.channel,
    quality: q !== null && q !== UNKNOWN_3 ? q : null,
    audioDbfs: audRms !== undefined ? audioToDbfs(audRms, family) : null,
    rfPercent,
    antennas,
  };
}

/**
 * "BB" -> ['B','B'], "BRXB" -> ['B','R','X','B'].
 *
 * ULX-D reports an antenna letter rather than a per-antenna string, so a
 * single character is one antenna there and two characters are two.
 */
function splitAntennas(raw: string): string[] {
  return raw.split('').filter(c => /[XRBA-D]/i.test(c));
}

// ── Building commands ───────────────────────────────────────────────────────

export function getAll(channel: number): string {
  return `< GET ${channel} ALL >`;
}

export function getDeviceParam(param: string): string {
  return `< GET ${param} >`;
}

export function getChannelParam(channel: number, param: string): string {
  return `< GET ${channel} ${param} >`;
}

/**
 * Metering interval in milliseconds, as a 5-character fixed-width field.
 *
 * 0 turns metering off, which is what a client must send before it drops the
 * socket — otherwise the receiver keeps metering into a connection nobody is
 * reading.
 */
export function setMeterRate(channel: number, intervalMs: number): string {
  const ms = clamp(Math.round(intervalMs), 0, 65535);
  return `< SET ${channel} METER_RATE ${String(ms).padStart(5, '0')} >`;
}

export function setMute(channel: number, muted: boolean, family: ShureFamily): string {
  return `< SET ${channel} ${FAMILIES[family].param.mute} ${muted ? 'ON' : 'OFF'} >`;
}

/** Frequency is set in kHz, without the leading-zero padding a REP carries. */
export function setFrequency(channel: number, khz: number): string {
  return `< SET ${channel} FREQUENCY ${Math.round(khz)} >`;
}

export function setChannelName(channel: number, name: string): string {
  return `< SET ${channel} CHAN_NAME {${name}} >`;
}
