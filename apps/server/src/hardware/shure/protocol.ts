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
    /** A real 0-100 charge figure, preferred over the five-bar gauge. */
    battPercent: string;
    battMins: string;
    mute: string;
    /**
     * Parameters that some families expose as individually query-able and
     * others deliver only inside a metering SAMPLE.
     *
     * Undefined means "this family has no such parameter name" — not "we have
     * not looked it up". ULX-D and QLX-D genuinely have none: their
     * specification documents RF, audio and antenna state only as fields of
     * `< SAMPLE x ALL nn aaa eee >`. Names for them appear in one third-party
     * implementation, are absent from Shure's document and from every other
     * implementation checked, and are never actually sent by any of them.
     * Carrying invented names here would produce GETs that are answered by
     * silence, which is the least diagnosable failure this protocol has.
     */
    rfLevel?: string;
    audioLevel?: string;
    antenna?: string;
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
      battPercent: 'TX_BATT_CHARGE_PERCENT',
      battMins:    'TX_BATT_MINS',
      mute:        'AUDIO_MUTE',
      rfLevel:     'RSSI',
      audioLevel:  'AUDIO_LEVEL_RMS',
      antenna:     'ANTENNA_STATUS',
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
      battPercent: 'BATT_CHARGE',
      battMins:    'BATT_RUN_TIME',
      mute:        'AUDIO_MUTE',
      // rfLevel, audioLevel and antenna deliberately absent — see FamilySpec.
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
      battPercent: 'BATT_CHARGE',
      battMins:    'BATT_RUN_TIME',
      mute:        'AUDIO_MUTE',
      // rfLevel, audioLevel and antenna deliberately absent — see FamilySpec.
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
 * Shure receivers that speak this protocol but that RFDeck cannot yet drive.
 *
 * Named explicitly so they can be refused rather than misidentified. SLX-D is
 * the case that matters: it answers `MODEL` exactly as Axient does, but its
 * metering sample is a different shape — three fields with no antenna status
 * and no channel quality. Treated as Axient, its audio peak would be read as
 * channel quality and its RF level as an antenna string, and every value on
 * the dashboard would be wrong while looking entirely plausible.
 *
 * See docs/MANUFACTURER_ROADMAP.md for what each of these needs.
 */
const KNOWN_UNSUPPORTED: Array<{ match: RegExp; what: string }> = [
  { match: /\bSLX-?D/i,                what: 'SLX-D' },
  { match: /\bP10T\b|\bPSM\s?1000\b/i, what: 'PSM1000 (IEM transmitter)' },
  { match: /\bUR4|\bUHF-?R\b/i,        what: 'UHF-R' },
];

/**
 * A Shure model this build knows about but cannot drive, or null.
 *
 * "Recognised and refused" is a far better outcome than "misidentified": an
 * operator gets a message naming their receiver, rather than a channel strip
 * full of numbers that are quietly meaningless.
 */
export function unsupportedModel(model: string): string | null {
  const m = (model ?? '').trim();
  if (!m) return null;
  for (const entry of KNOWN_UNSUPPORTED) {
    if (entry.match.test(m)) return entry.what;
  }
  return null;
}

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
 * Per-family conversion offsets, from each family's own specification.
 *
 * These are NOT the same, and the first version of this file used Axient's for
 * everything after taking micboard's display scaling for a unit conversion.
 * micboard maps ULX-D audio to a percentage with `2 x raw` and RF with
 * `raw / 115` — good numbers for its own meters, but not what the fields mean.
 *
 *   Axient    "actualValue = reportedValue - 120", for RSSI (dBm) and for
 *             AUDIO_LEVEL_RMS / AUDIO_LEVEL_PEAK (dBFS).
 *   ULX-D     "Where aaa is the value of the RF level received and is 000-115.
 *             To convert this value to dBm, subtract 128." Audio is documented
 *             only as "the audio level and is 000-050" -- no units given, so
 *             the -50 below is inferred, matching what Bitfocus Companion's
 *             Shure module does. It is the only value here not stated outright
 *             by Shure.
 */
const FAMILY_OFFSETS: Record<ShureFamily, { rssi: number; audio: number }> = {
  axtd: { rssi: 120, audio: 120 },
  ulxd: { rssi: 128, audio: 50 },
  qlxd: { rssi: 128, audio: 50 },
};

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
 * Battery charge as a real percentage.
 *
 * Both families report one — Axient as TX_BATT_CHARGE_PERCENT and ULX-D as
 * BATT_CHARGE, both "000 - 100 : Percent, 255 : Unknown". An earlier version
 * of this file claimed Axient had no such parameter and fell back to the
 * five-bar gauge for everything; that came from grepping the specification for
 * the wrong name and believing the absence of a match.
 */
export function parseBatteryPercent(raw: string): number | null {
  const n = num(raw);
  if (n === null || n === UNKNOWN_3) return null;
  return n >= 0 && n <= 100 ? n : null;
}

/**
 * Battery as a percentage, from the five-bar gauge.
 *
 * The fallback, for a transmitter that reports bars but not charge. Coarse —
 * 0, 20, 40, 60, 80, 100 — so the real percentage is always preferred.
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

/** dBm from a reported RSSI field, by that family's documented offset. */
export function rssiToDbm(raw: string | number, family: ShureFamily): number | null {
  const n = num(raw);
  return n === null ? null : n - FAMILY_OFFSETS[family].rssi;
}

/**
 * The dBm window RFDeck maps onto its 0-100 RF meter.
 *
 * Once each family's raw field is converted to real dBm, one window serves
 * them all — which is the point of converting rather than rescaling.
 *
 * The numbers are chosen for where they leave the thresholds the rest of the
 * application already uses, not for mathematical tidiness. A wireless mic
 * receiver squelches somewhere around -95 dBm, a well-set-up link sits between
 * -60 and -40, and anything above -35 is as good as it gets.
 *
 *   RFDeck calls a channel CRITICAL below 20%  ->  -83 dBm, genuinely near squelch
 *   ...and marginal below 35%                  ->  -74 dBm, worth watching
 *   A healthy -50 dBm link reads 75%, which looks healthy on a meter.
 */
const RF_FLOOR_DBM = -95;
const RF_CEILING_DBM = -35;

export function dbmToPercent(dbm: number): number {
  const span = RF_CEILING_DBM - RF_FLOOR_DBM;
  return clamp(Math.round(((dbm - RF_FLOOR_DBM) / span) * 100), 0, 100);
}

/** RF as the 0-100 RFDeck shows on a meter, via real dBm. */
export function rssiToPercent(raw: string | number, family: ShureFamily): number | null {
  const dbm = rssiToDbm(raw, family);
  return dbm === null ? null : dbmToPercent(dbm);
}

/**
 * Audio level as dBFS, which is what DeviceManagerService expects on
 * `af_level` — it applies `100 + dBFS` itself, the same as for Sennheiser.
 */
export function audioToDbfs(raw: string | number, family: ShureFamily): number | null {
  const n = num(raw);
  if (n === null) return null;
  return n - FAMILY_OFFSETS[family].audio;
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
      // One RF figure, not one per antenna: the ULX-D sample is
      // "< SAMPLE x ALL nn aaa eee >", where nn is only which antenna LEDs are
      // lit. There is no second RSSI to report.
      rfPercent: rf !== undefined ? [rssiToPercent(rf, family) ?? 0] : [],
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
    rfPercent.push(rssiToPercent(rssi, family) ?? 0);
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
 * One character per antenna. The vocabularies differ between families:
 *
 *   Axient   X off, R red, B blue -- "BB", or "BRXB" on Quadversity
 *   ULX-D    positional: "AX" is antenna A on and B off, "XB" the reverse,
 *            "XX" both off
 *
 * Either way the length is the antenna count, which is what the Axient sample
 * parser needs in order not to read a frequency-diversity section as extra
 * antennas.
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
