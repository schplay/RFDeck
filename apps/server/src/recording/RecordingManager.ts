import fs from 'fs';
import path from 'path';
import { Server } from 'socket.io';
import { prisma } from '../db';
import { log } from '../logger';
import { CaptureManager } from '../audio/CaptureManager';
import { PcmRing, encodeWav, selectForPruning } from './pcm';
import { ChannelDetector, frameFeatures, shouldPromote } from './detectors';

/**
 * What the RF side knows about a channel right now.
 *
 * The audio detectors cannot tell a dropout from a pause, or fuzz from a
 * sibilant, on their own. This is the evidence that settles it — and the
 * reason a mute by the performer is not reported as a fault.
 */
export interface RfContext {
  /** RF is low or the channel is in dropout. */
  marginal: boolean;
  /** Muted at the transmitter or the receiver — silence here is deliberate. */
  muted: boolean;
}

// Rolling capture and incident clips.
//
// Every channel with an audio patch is recorded continuously — recording is
// not a mode to remember to switch on, because the problem worth reviewing is
// always the one nobody predicted. Only a short pre-roll is held in memory per
// channel; when a detection fires, that pre-roll plus a live post-roll is
// written to disk as a clip and attached to a Detection row.
//
// Storage is bounded by a budget the operator sets. Clips fill it FIFO, oldest
// discarded first, except flagged ones — flagging is what says "keep this".

const SAMPLE_RATE = CaptureManager.SAMPLE_RATE;

export interface DetectionInput {
  channelKey: string;
  channelName?: string | null;
  deviceId?: string | null;
  trigger: string;
  severity?: string;
  message: string;
  rfLevelA?: number | null;
  rfLevelB?: number | null;
}

interface Recorder {
  deviceId: string;
  inputChannel: number;
  ring: PcmRing;
  stop: () => void;
  /** Post-roll being collected for a detection that already fired. */
  pending: Array<{ detectionId: string; want: number; got: Int16Array[]; have: number }>;
  /** Watches this channel's audio for the signatures of a wireless fault. */
  detector: ChannelDetector;
}

export class RecordingManager {
  private recorders = new Map<string, Recorder>();
  private clipsDir: string;
  private config = { enabled: true, maxMb: 2048, preSec: 15, postSec: 10 };
  private pruneChain: Promise<void> = Promise.resolve();

  /** Last detection per channel, from any source, for cross-source suppression. */
  private lastDetectionAt = new Map<string, number>();
  private static readonly CROSS_SOURCE_QUIET_MS = 5_000;

  constructor(
    private readonly capture: CaptureManager,
    private readonly io: Server,
    /** Supplied by the socket plugin; absent in tests and on a desktop build. */
    private readonly rfContext?: (channelKey: string) => RfContext,
  ) {
    this.clipsDir = RecordingManager.resolveClipsDir();
  }

  // Beside the database, so clips travel with the data they describe and land
  // on whatever volume the operator pointed the install at.
  static resolveClipsDir(): string {
    const url = process.env.DATABASE_URL ?? '';
    const match = url.match(/^file:(.+)$/);
    if (match) {
      const dbPath = path.resolve(process.cwd(), match[1]);
      return path.join(path.dirname(dbPath), 'clips');
    }
    return path.resolve(__dirname, '../../prisma/clips');
  }

  get directory(): string {
    return this.clipsDir;
  }

  async start(): Promise<void> {
    try {
      fs.mkdirSync(this.clipsDir, { recursive: true });
    } catch (err: any) {
      log.error(`[recording] Cannot create ${this.clipsDir}: ${err?.message} — recording disabled`);
      this.config.enabled = false;
      return;
    }
    await this.reload();
  }

  /** Re-read settings and patches, then bring the running taps in line. */
  async reload(): Promise<void> {
    const settings = await prisma.settings.findFirst();
    this.config = {
      enabled: settings?.recordingEnabled ?? true,
      maxMb:   settings?.recordingMaxMb ?? 2048,
      preSec:  Math.max(1, settings?.recordingPreSec ?? 15),
      postSec: Math.max(0, settings?.recordingPostSec ?? 10),
    };

    const patches = this.config.enabled ? await prisma.channelAudioMap.findMany() : [];
    const wanted = new Map(patches.map(p => [p.channelKey, p]));

    // Drop recorders whose patch went away or moved.
    for (const [key, rec] of [...this.recorders]) {
      const patch = wanted.get(key);
      if (!patch || patch.deviceId !== rec.deviceId || patch.inputChannel !== rec.inputChannel) {
        rec.stop();
        this.recorders.delete(key);
      }
    }

    // Start recorders for anything newly patched.
    for (const [key, patch] of wanted) {
      if (this.recorders.has(key)) continue;
      this.startRecorder(key, patch.deviceId, patch.inputChannel);
    }

    log.info(
      `[recording] ${this.recorders.size} channel(s) recording, ` +
      `${this.config.preSec}s pre / ${this.config.postSec}s post, ` +
      `budget ${this.config.maxMb} MB${this.config.enabled ? '' : ' (disabled)'}`,
    );
  }

  private startRecorder(channelKey: string, deviceId: string, inputChannel: number): void {
    const ring = new PcmRing(SAMPLE_RATE * this.config.preSec);
    const rec: Recorder = {
      deviceId, inputChannel, ring, stop: () => {}, pending: [],
      detector: new ChannelDetector(),
    };

    const stop = this.capture.addTap(deviceId, inputChannel, (samples) => {
      ring.push(samples);

      // Watch the audio itself for the signatures of a wireless fault. See
      // docs/AUDIO_DETECTION.md — the RF context is what keeps this from
      // reporting every sibilant and every pause.
      const event = rec.detector.push(frameFeatures(samples), Date.now());
      if (event) this.considerAudioEvent(channelKey, deviceId, event);

      // Feed any post-roll still being collected, and finish the ones that
      // have enough. Iterated over a copy: finalize mutates the list.
      if (rec.pending.length === 0) return;
      for (const p of [...rec.pending]) {
        p.got.push(samples);
        p.have += samples.length;
        if (p.have >= p.want) {
          rec.pending = rec.pending.filter(x => x !== p);
          void this.finalize(channelKey, p.detectionId, p.got, p.want);
        }
      }
    });

    if (!stop) {
      log.warn(`[recording] Could not tap ${deviceId} input ${inputChannel} for "${channelKey}"`);
      return;
    }
    rec.stop = stop;
    this.recorders.set(channelKey, rec);
  }

  // Decide whether an audio candidate is worth reporting.
  private considerAudioEvent(
    channelKey: string,
    deviceId: string,
    event: { kind: string; confidence: number; message: string; durationMs: number },
  ): void {
    const ctx = this.rfContext?.(channelKey);

    // A muted channel is silent on purpose. Reporting a performer's own mute
    // switch as a dropout would be the fastest way to make this untrusted.
    if (ctx?.muted) return;

    if (!shouldPromote(event as any, ctx?.marginal ?? false)) return;

    // The RF side may already have reported this same incident a moment ago —
    // one dropout should not appear twice because two detectors noticed it.
    const last = this.lastDetectionAt.get(channelKey) ?? 0;
    if (Date.now() - last < RecordingManager.CROSS_SOURCE_QUIET_MS) return;

    void this.record({
      channelKey,
      channelName: channelKey,
      deviceId,
      trigger: event.kind,
      severity: event.confidence >= 0.8 ? 'CRITICAL' : 'WARNING',
      message: ctx?.marginal
        ? `${event.message} (RF was marginal)`
        : event.message,
    });
  }

  /**
   * Record a detection, and capture the clip around it.
   *
   * The row is written immediately so the incident is never lost waiting on
   * audio; the clip is attached when the post-roll completes.
   */
  async record(input: DetectionInput): Promise<string | null> {
    let showId: string | null = null;
    let act: number | null = null;
    try {
      const show = await prisma.show.findFirst({
        where: { archived: false },
        orderBy: { updatedAt: 'desc' },
      });
      if (show) { showId = show.id; act = show.currentAct; }
    } catch { /* scoping is a nicety; never block the detection */ }

    let detection;
    try {
      detection = await prisma.detection.create({
        data: {
          channelKey:  input.channelKey,
          channelName: input.channelName ?? null,
          deviceId:    input.deviceId ?? null,
          trigger:     input.trigger,
          severity:    input.severity ?? 'WARNING',
          message:     input.message,
          rfLevelA:    input.rfLevelA ?? null,
          rfLevelB:    input.rfLevelB ?? null,
          showId, act,
        },
      });
    } catch (err: any) {
      log.warn(`[recording] Could not record detection: ${err?.message}`);
      return null;
    }

    this.lastDetectionAt.set(input.channelKey, Date.now());
    this.io.emit('detection:new', detection);

    const rec = this.recorders.get(input.channelKey);
    if (!rec || !this.config.enabled) {
      // No patch on this channel, so there is no audio to attach. The
      // detection still stands — it just cannot be listened to.
      return detection.id;
    }

    const pre = rec.ring.read(SAMPLE_RATE * this.config.preSec);
    const postWanted = SAMPLE_RATE * this.config.postSec;
    if (postWanted === 0) {
      void this.finalize(input.channelKey, detection.id, [pre], pre.length);
    } else {
      rec.pending.push({ detectionId: detection.id, want: postWanted, got: [pre], have: 0 });
    }
    return detection.id;
  }

  // Join pre-roll and post-roll, write the WAV, attach it, then prune.
  private async finalize(
    channelKey: string,
    detectionId: string,
    chunks: Int16Array[],
    _want: number,
  ): Promise<void> {
    try {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const all = new Int16Array(total);
      let at = 0;
      for (const c of chunks) { all.set(c, at); at += c.length; }

      const file = `${detectionId}.wav`;
      const wav = encodeWav(all, SAMPLE_RATE);
      await fs.promises.writeFile(path.join(this.clipsDir, file), wav);

      const updated = await prisma.detection.update({
        where: { id: detectionId },
        data: {
          clipPath:  file,
          clipBytes: wav.length,
          clipMs:    Math.round((total / SAMPLE_RATE) * 1000),
        },
      });
      this.io.emit('detection:updated', updated);
      this.schedulePrune();
    } catch (err: any) {
      log.warn(`[recording] Could not write clip for "${channelKey}": ${err?.message}`);
    }
  }

  // Serialised: two prunes racing would double-count and over-delete.
  private schedulePrune(): void {
    this.pruneChain = this.pruneChain.then(() => this.prune()).catch(() => {});
  }

  async prune(): Promise<void> {
    const budget = this.config.maxMb * 1024 * 1024;
    const clips = await prisma.detection.findMany({
      where: { clipPath: { not: null } },
      select: { id: true, clipPath: true, clipBytes: true, flagged: true, timestamp: true },
    });

    const { remove, overBudgetByFlagged } = selectForPruning(
      clips.map(c => ({ id: c.id, bytes: c.clipBytes, flagged: c.flagged, at: c.timestamp.getTime() })),
      budget,
    );
    if (remove.length === 0) {
      if (overBudgetByFlagged) {
        log.warn('[recording] Flagged clips alone exceed the storage budget; nothing was pruned');
      }
      return;
    }

    const byId = new Map(clips.map(c => [c.id, c.clipPath!]));
    for (const id of remove) {
      const file = byId.get(id);
      if (file) {
        await fs.promises.unlink(path.join(this.clipsDir, file)).catch(() => {});
      }
    }
    // The detections survive; only their audio is reclaimed. The incident
    // record is small and is what a report is built from.
    await prisma.detection.updateMany({
      where: { id: { in: remove } },
      data:  { clipPath: null, clipBytes: 0 },
    });
    log.info(`[recording] Pruned ${remove.length} clip(s) to stay within ${this.config.maxMb} MB`);
    this.io.emit('detection:pruned', { ids: remove });

    if (overBudgetByFlagged) {
      log.warn('[recording] Still over budget after pruning: flagged clips are exempt');
    }
  }

  clipFile(name: string): string | null {
    // Only ever a bare filename from our own rows; refuse anything with a path
    // separator so a crafted value cannot escape the clips directory.
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
    const full = path.join(this.clipsDir, name);
    return fs.existsSync(full) ? full : null;
  }

  async status(): Promise<{
    enabled: boolean; maxMb: number; usedMb: number; clipCount: number;
    freeMb: number | null; totalMb: number | null;
    preSec: number; postSec: number;
    channels: Array<{ channelKey: string; deviceId: string; inputChannel: number }>;
    directory: string;
  }> {
    const agg = await prisma.detection.aggregate({
      where: { clipPath: { not: null } },
      _sum: { clipBytes: true },
      _count: true,
    });

    let freeMb: number | null = null;
    let totalMb: number | null = null;
    try {
      // statfs is how the operator learns what they actually have to spend —
      // a budget field with no sense of the disk behind it is a guess.
      const st = await (fs.promises as any).statfs?.(this.clipsDir);
      if (st) {
        freeMb  = Math.round((Number(st.bsize) * Number(st.bavail)) / (1024 * 1024));
        totalMb = Math.round((Number(st.bsize) * Number(st.blocks)) / (1024 * 1024));
      }
    } catch { /* not available on every platform; the budget still works */ }

    return {
      enabled: this.config.enabled,
      maxMb:   this.config.maxMb,
      usedMb:  Math.round((agg._sum.clipBytes ?? 0) / (1024 * 1024)),
      clipCount: agg._count,
      freeMb, totalMb,
      preSec: this.config.preSec,
      postSec: this.config.postSec,
      channels: [...this.recorders.entries()].map(([channelKey, r]) => ({
        channelKey, deviceId: r.deviceId, inputChannel: r.inputChannel,
      })),
      directory: this.clipsDir,
    };
  }

  stopAll(): void {
    for (const rec of this.recorders.values()) rec.stop();
    this.recorders.clear();
  }
}
