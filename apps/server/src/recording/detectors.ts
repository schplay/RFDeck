// Finding wireless faults in the audio itself.
//
// See docs/AUDIO_DETECTION.md for the reasoning and sources. In short:
//
//   • A digital link fails by muting — the waveform drops to silence abruptly.
//   • An analog link fails by degrading into broadband noise — "fuzz".
//   • Interference can produce an impulsive click.
//
// Each of those has a legitimate look-alike: a pause, a sibilant, a plosive.
// The discriminator is that RFDeck knows the RF level of the same channel at
// the same moment, which a general-purpose audio detector never does — so the
// audio raises a candidate and RF decides whether it is a fault.
//
// Everything here is pure: features in, events out, no I/O and no clock of its
// own. The frame timestamp is supplied by the caller.

/** Full scale for signed 16-bit samples. */
const FULL_SCALE = 32768;

export function dbfs(linear: number): number {
  return linear <= 0 ? -Infinity : 20 * Math.log10(linear / FULL_SCALE);
}

export interface FrameFeatures {
  /** Root mean square, linear 0..32768. */
  rms: number;
  /** Largest absolute sample in the frame. */
  peak: number;
  /** Zero crossings as a fraction of the frame — high for noise. */
  zcr: number;
  /**
   * Normalised lag-1 autocorrelation, -1..1.
   *
   * The cheap stand-in for spectral flatness: white noise sits near 0, any
   * signal with low-frequency energy (all voiced speech) heads toward 1. One
   * pass over the frame instead of an FFT per channel per 10 ms.
   */
  tonality: number;
  /** Largest |s[n] - 2s[n-1] + s[n-2]| — a high-passed impulse measure. */
  maxD2: number;
}

/** One linear pass over a frame of mono samples. */
export function frameFeatures(samples: Int16Array): FrameFeatures {
  const n = samples.length;
  if (n === 0) return { rms: 0, peak: 0, zcr: 0, tonality: 1, maxD2: 0 };

  let sumSq = 0;
  let peak = 0;
  let crossings = 0;
  let lagSum = 0;      // Σ s[n]·s[n-1], for the autocorrelation
  let maxD2 = 0;

  for (let i = 0; i < n; i++) {
    const s = samples[i];
    sumSq += s * s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;

    if (i > 0) {
      const p = samples[i - 1];
      lagSum += s * p;
      // A sign change with both samples non-trivial. Ignoring near-zero
      // samples keeps dither and silence from reading as a noise burst.
      if ((s > 0) !== (p > 0) && (a > 8 || (p < 0 ? -p : p) > 8)) crossings++;
    }
    if (i > 1) {
      const d2 = s - 2 * samples[i - 1] + samples[i - 2];
      const ad2 = d2 < 0 ? -d2 : d2;
      if (ad2 > maxD2) maxD2 = ad2;
    }
  }

  const rms = Math.sqrt(sumSq / n);
  // ρ₁ = Σ s[n]s[n-1] / Σ s[n]². Undefined for silence; call it tonal so a
  // silent frame is never mistaken for noise.
  const tonality = sumSq > 0 ? Math.max(-1, Math.min(1, lagSum / sumSq)) : 1;

  return { rms, peak, zcr: crossings / n, tonality, maxD2 };
}

export type DetectorKind = 'AUDIO_DROPOUT' | 'AUDIO_NOISE' | 'AUDIO_CLICK';

export interface DetectorEvent {
  kind: DetectorKind;
  /** Frame timestamp the caller supplied, in ms. */
  atMs: number;
  /** How long the condition had held when it fired, in ms. */
  durationMs: number;
  /** 0..1. Below `promoteWithoutRf` a candidate needs RF corroboration. */
  confidence: number;
  message: string;
}

export interface DetectorConfig {
  /** Frame length in ms — what one `push` represents. */
  frameMs: number;
  /** Below this the channel counts as silent. dBFS. */
  silenceDb: number;
  /** Above this the channel counts as carrying programme. dBFS. */
  presenceDb: number;
  /** A fall at least this large is abrupt rather than a natural decay. dB. */
  abruptDropDb: number;
  /** Silence must hold this long before it is a dropout. ms. */
  minDropoutMs: number;
  /** ρ₁ below this is noise-like. */
  noiseTonality: number;
  /** Noise must hold this long to be a candidate. ms. */
  minNoiseMs: number;
  /**
   * Noise sustained beyond this is longer than any sibilant, so it stands on
   * its own without RF corroboration. ms.
   */
  sibilantMaxMs: number;
  /** Impulse threshold, in multiples of the robust baseline. */
  clickSigmas: number;
  /** Confidence at or above which an event needs no RF corroboration. */
  promoteWithoutRf: number;
  /** Silence between two events on one channel. ms. */
  refractoryMs: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  frameMs: 10,
  silenceDb: -65,
  presenceDb: -45,
  abruptDropDb: 20,
  minDropoutMs: 40,
  noiseTonality: 0.2,
  minNoiseMs: 60,
  sibilantMaxMs: 400,
  clickSigmas: 14,
  promoteWithoutRf: 0.8,
  refractoryMs: 3_000,
};

/**
 * Per-channel state machine. Feed it frames; it returns an event or null.
 *
 * Deliberately conservative: an operator who sees one false detection during a
 * show stops believing the next ten, so every rule here prefers a miss to a
 * cry of wolf, and leans on RF corroboration for anything ambiguous.
 */
export class ChannelDetector {
  private readonly cfg: DetectorConfig;

  /**
   * The last few frame levels, for judging how abrupt a fall was.
   *
   * Abruptness has to be measured against the *immediately* preceding frames,
   * not a peak from seconds ago: a singer ending a phrase is also quiet after
   * having been loud, and comparing to an old peak calls every one of those a
   * dropout. A mute falls to silence within a frame or two; speech does not.
   */
  private levelHistory: number[] = [];
  private static readonly HISTORY_FRAMES = 4;

  private silentSinceMs: number | null = null;
  private dropFromDb = -Infinity;
  private noisySinceMs: number | null = null;
  private noiseEmitted = false;
  private lastEventAtMs = -Infinity;

  /**
   * Robust baseline for the impulse measure.
   *
   * Updated only from frames at or below the current threshold, so a click
   * cannot raise the bar that should have caught it — the EMA equivalent of
   * MAD's resistance to being dragged by its own outliers.
   */
  private d2Baseline = 0;
  private framesSeen = 0;

  constructor(config: Partial<DetectorConfig> = {}) {
    this.cfg = { ...DEFAULT_DETECTOR_CONFIG, ...config };
  }

  get config(): DetectorConfig {
    return this.cfg;
  }

  /** Forget history — used when a channel's patch changes underneath us. */
  reset(): void {
    this.levelHistory = [];
    this.silentSinceMs = null;
    this.dropFromDb = -Infinity;
    this.noisySinceMs = null;
    this.noiseEmitted = false;
    this.d2Baseline = 0;
    this.framesSeen = 0;
  }

  push(f: FrameFeatures, atMs: number): DetectorEvent | null {
    const level = dbfs(f.rms);
    const cfg = this.cfg;

    const event =
      this.checkDropout(level, atMs) ??
      this.checkNoise(f, level, atMs) ??
      this.checkClick(f, level, atMs);

    // Recorded after the checks, so a detector always compares against the
    // frames BEFORE the one it is judging.
    this.levelHistory.push(level);
    if (this.levelHistory.length > ChannelDetector.HISTORY_FRAMES) this.levelHistory.shift();

    // One event per channel per refractory window: a dropout is one incident,
    // not one per frame for as long as it lasts.
    if (event) {
      if (atMs - this.lastEventAtMs < cfg.refractoryMs) return null;
      this.lastEventAtMs = atMs;
      return event;
    }
    return null;
  }

  private checkDropout(level: number, atMs: number): DetectorEvent | null {
    const cfg = this.cfg;

    if (level > cfg.silenceDb) {
      this.silentSinceMs = null;
      return null;
    }

    if (this.silentSinceMs === null) {
      this.silentSinceMs = atMs;
      // The level in the frames immediately before this one. A mute falls from
      // full programme within a frame or two; a phrase ending has already
      // faded through these, so it never looks like a fall from loud.
      this.dropFromDb = this.levelHistory.length > 0
        ? Math.max(...this.levelHistory)
        : -Infinity;
    }
    const heldMs = atMs - this.silentSinceMs + cfg.frameMs;
    if (heldMs < cfg.minDropoutMs) return null;

    const fellFrom = this.dropFromDb;
    if (fellFrom < cfg.presenceDb) return null;
    if (fellFrom - level < cfg.abruptDropDb) return null;

    // Silence following loud programme is unambiguous on its own; a smaller
    // fall wants RF to agree.
    const confidence = fellFrom > cfg.presenceDb + 12 ? 0.85 : 0.6;

    return {
      kind: 'AUDIO_DROPOUT',
      atMs,
      durationMs: heldMs,
      confidence,
      message:
        `Audio cut out abruptly — fell ${Math.round(fellFrom - level)} dB to silence ` +
        `and stayed there for ${Math.round(heldMs)} ms`,
    };
  }

  private checkNoise(f: FrameFeatures, level: number, atMs: number): DetectorEvent | null {
    const cfg = this.cfg;

    // Broadband and actually audible. ZCR corroborates: noise crosses zero far
    // more often than voiced speech at the same level.
    const noiseLike = f.tonality < cfg.noiseTonality && f.zcr > 0.2 && level > cfg.silenceDb + 10;

    if (!noiseLike) {
      // The run ended. A burst short enough to have been a sibilant is
      // reported only now, when its true length is known — firing the moment
      // it passed the minimum would have to guess.
      const started = this.noisySinceMs;
      const emitted = this.noiseEmitted;
      this.noisySinceMs = null;
      this.noiseEmitted = false;

      if (started !== null && !emitted) {
        const heldMs = atMs - started;
        if (heldMs >= cfg.minNoiseMs) {
          return {
            kind: 'AUDIO_NOISE',
            atMs,
            durationMs: heldMs,
            // Indistinguishable from /s/ or /ʃ/ on audio alone: RF decides.
            confidence: 0.5,
            message: `Broadband noise on the channel for ${Math.round(heldMs)} ms`,
          };
        }
      }
      return null;
    }

    if (this.noisySinceMs === null) {
      this.noisySinceMs = atMs;
      this.noiseEmitted = false;
    }
    const heldMs = atMs - this.noisySinceMs + cfg.frameMs;

    // Past any plausible sibilant this is not speech, and there is no reason to
    // wait for it to stop — report it while it is still happening.
    if (!this.noiseEmitted && heldMs > cfg.sibilantMaxMs) {
      this.noiseEmitted = true;
      return {
        kind: 'AUDIO_NOISE',
        atMs,
        durationMs: heldMs,
        confidence: 0.85,
        message:
          `Broadband noise on the channel for ${Math.round(heldMs)} ms — ` +
          `longer than any speech sound`,
      };
    }
    return null;
  }

  private checkClick(f: FrameFeatures, level: number, atMs: number): DetectorEvent | null {
    const cfg = this.cfg;
    const d2 = f.maxD2;

    // Warm up before judging anything: the first frames have no baseline.
    this.framesSeen++;
    if (this.framesSeen < 50) {
      this.d2Baseline = this.d2Baseline === 0 ? d2 : this.d2Baseline * 0.9 + d2 * 0.1;
      return null;
    }

    const threshold = Math.max(this.d2Baseline * cfg.clickSigmas, FULL_SCALE * 0.02);

    // A click is an ISOLATED spike in otherwise smooth signal. Two guards
    // separate that from a burst of noise, which also has large sample-to-
    // sample steps but is the other detector's business:
    //
    //   • the frame must not be broadband overall, and
    //   • crest factor must be high — one spike lifts the peak far above the
    //     RMS, whereas white noise sits around 3-4x.
    const crest = f.rms > 0 ? f.peak / f.rms : 0;
    const isolated = f.tonality >= cfg.noiseTonality && crest > 6;
    const isClick = d2 > threshold && level > cfg.silenceDb && isolated;

    // Update the baseline only from frames that did not trip it.
    if (!isClick) {
      this.d2Baseline = this.d2Baseline * 0.98 + d2 * 0.02;
      return null;
    }

    // A click always wants RF corroboration: a plosive or a knock on the mic
    // looks the same, and claiming those as faults is how a detector loses an
    // operator's trust for good.
    return {
      kind: 'AUDIO_CLICK',
      atMs,
      durationMs: cfg.frameMs,
      confidence: 0.45,
      message: `Impulsive click, ${Math.round(d2 / this.d2Baseline)}x the channel's normal transient level`,
    };
  }
}

/**
 * Should a candidate become a Detection?
 *
 * High-confidence audio stands alone. Anything ambiguous needs the RF to have
 * been marginal nearby in time — which is exactly the evidence a general audio
 * detector cannot consult, and the reason this can run on a live vocal mic
 * without crying wolf at every sibilant.
 */
export function shouldPromote(
  event: DetectorEvent,
  rfWasMarginal: boolean,
  cfg: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
): boolean {
  if (event.confidence >= cfg.promoteWithoutRf) return true;
  return rfWasMarginal;
}
