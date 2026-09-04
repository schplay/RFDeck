import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { log } from '../logger';

// Where captured audio actually comes from, per operating system.
//
// The capture path was written against ALSA — `arecord` for both enumeration
// and capture, `/proc/asound` for the device list. That is correct on the
// headless Linux server and completely absent on Windows and macOS, so the
// desktop build shipped with no audio at all: no devices to patch, and nothing
// to listen to if you had patched one.
//
// The shape of the problem is the same everywhere: list the inputs, ask one
// how many channels it has, then spawn something that writes raw interleaved
// S16LE to stdout. Only the command differs. So the platform-specific part is
// isolated here and CaptureManager stays one implementation.
//
//   Linux    arecord            (ALSA, already installed)
//   Windows  ffmpeg -f dshow
//   macOS    ffmpeg -f avfoundation

export interface AudioInputDevice {
  /** Opaque to everything above this file; stable enough to store in a patch. */
  id: string;
  label: string;
  card: number;
  device: number;
  channels: number;
  channelsProbed: boolean;
}

export interface CaptureCommand {
  command: string;
  args: string[];
}

export interface CaptureBackend {
  readonly id: 'alsa' | 'dshow' | 'avfoundation';
  readonly label: string;
  /** Can this backend run at all — is its tool present? */
  available(): boolean;
  /** Said to the operator when it cannot. */
  unavailableReason(): string;
  listDevices(): AudioInputDevice[];
  probeChannels(deviceId: string): number | null;
  captureCommand(deviceId: string, channels: number, rate: number): CaptureCommand;
}

// ── Finding ffmpeg ──────────────────────────────────────────────────────────
//
// Order matters: an explicitly configured binary wins, then the one the
// desktop build ships, then whatever is on PATH. The desktop app sets
// FFMPEG_PATH when it spawns the server, which is how a packaged install finds
// its bundled copy without the server knowing anything about packaging.

let cachedFfmpeg: string | null | undefined;

export function resolveFfmpeg(): string | null {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;

  const fromEnv = process.env.FFMPEG_PATH?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return (cachedFfmpeg = fromEnv);

  // Installed as a dependency somewhere above us.
  try {
    const req = eval('require') as NodeRequire;
    const staticPath = req('ffmpeg-static');
    if (typeof staticPath === 'string' && fs.existsSync(staticPath)) {
      return (cachedFfmpeg = staticPath);
    }
  } catch { /* not installed; fall through */ }

  // On PATH.
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return (cachedFfmpeg = candidate);
  }

  return (cachedFfmpeg = null);
}

/** Test seam; also lets a settings change take effect without a restart. */
export function clearFfmpegCache(): void {
  cachedFfmpeg = undefined;
}

// ffmpeg writes device listings and format probes to stderr — they are log
// output, not program output — and may exit with either status while doing it.
//
// spawnSync, not execFileSync: execFileSync hands back only stdout when the
// command succeeds, and throws when it does not. Against ffmpeg 6.1 the
// listing exits 0 with an empty stdout, so the whole device list came back
// empty and Windows reported "no capture devices" on a machine with seven of
// them. Both streams are wanted regardless of status.
export function runTool(bin: string, args: string[]): string {
  const r = spawnSync(bin, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000,
  });
  if (r.error) {
    log.warn(`[audio] ${path.basename(bin)} could not be run: ${r.error.message}`);
    return '';
  }
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

function runFfmpeg(args: string[]): string {
  const bin = resolveFfmpeg();
  return bin ? runTool(bin, args) : '';
}

// ── Parsing (pure, tested) ──────────────────────────────────────────────────

/**
 * Audio device names from `ffmpeg -list_devices true -f dshow -i dummy`.
 *
 * Two output shapes are still in the wild:
 *
 *   ffmpeg >= 5   [dshow @ ..] "Microphone (Realtek)" (audio)
 *   ffmpeg <= 4   [dshow @ ..] DirectShow audio devices
 *                 [dshow @ ..]  "Microphone (Realtek)"
 *
 * The old one groups entries under headings; the current one dropped the
 * headings and tags each line instead. This parser was first written against
 * the heading form from memory, and found exactly zero devices the first time
 * it met a real binary — hence the fixtures in the tests, captured verbatim
 * from ffmpeg 6.1.1 on Windows.
 *
 * Either way a webcam must not end up in the list, and the "Alternative name"
 * line that follows every entry is not a device.
 */
export function parseDshowDevices(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const tagged = lines.some(l => /"\s*\((?:audio|video|none)\)\s*$/i.test(l));
  const devices: string[] = [];
  let inAudio = false;

  for (const line of lines) {
    if (/Alternative name/i.test(line)) continue;

    if (tagged) {
      const m = line.match(/"([^"]+)"\s*\(audio\)\s*$/i);
      if (m) devices.push(m[1]);
      continue;
    }

    if (/DirectShow\s+audio\s+devices/i.test(line)) { inAudio = true; continue; }
    if (/DirectShow\s+video\s+devices/i.test(line)) { inAudio = false; continue; }
    if (!inAudio) continue;

    const m = line.match(/"([^"]+)"/);
    if (m) devices.push(m[1]);
  }
  return devices;
}

/**
 * Channel count from `ffmpeg -list_options true -f dshow -i audio=NAME`.
 *
 * One line per supported format; the widest is what the device can deliver.
 * The shape changed here too:
 *
 *   ffmpeg >= 5   ch= 2, bits=16, rate= 44100
 *   ffmpeg <= 4   min ch=1 bits=8 rate= 11025 max ch=2 bits=16 rate= 44100
 *
 * Taking the maximum over every `ch=` is correct for both — the old line's
 * `min` and `max` are just two more values to consider. Note the space after
 * the equals sign in the current form: a pattern expecting `ch=2` misses it.
 */
export function parseDshowChannels(output: string): number | null {
  let best: number | null = null;
  for (const m of output.matchAll(/\bch=\s*(\d+)/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) best = Math.max(best ?? 0, n);
  }
  return best;
}

/**
 * Audio devices from `ffmpeg -f avfoundation -list_devices true -i ""`.
 *
 * Headings did survive here, and entries are indexed rather than named:
 *
 *   [AVFoundation indev @ ..] AVFoundation audio devices:
 *   [AVFoundation indev @ ..] [0] Built-in Microphone  [uid:BuiltInMic]
 *
 * The trailing uid/serial annotations are recent — avfoundation.m prints
 * "[%d] %s  [uid:%s] [serial:%s]" — while older builds print the bare name.
 * They are an implementation detail, not part of what the operator should see.
 */
export function parseAvfoundationDevices(output: string): Array<{ index: number; name: string }> {
  const devices: Array<{ index: number; name: string }> = [];
  let inAudio = false;

  for (const line of output.split(/\r?\n/)) {
    if (/AVFoundation\s+audio\s+devices/i.test(line)) { inAudio = true; continue; }
    if (/AVFoundation\s+video\s+devices/i.test(line)) { inAudio = false; continue; }
    if (!inAudio) continue;

    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (!m) continue;
    const name = m[2].replace(/\s*\[(?:uid|serial):[^\]]*\]/gi, '').trim();
    if (name) devices.push({ index: Number(m[1]), name });
  }
  return devices;
}

// ── Windows ─────────────────────────────────────────────────────────────────

const FFMPEG_MISSING =
  'ffmpeg was not found, so audio devices cannot be listed or captured. ' +
  'The desktop build ships one; install ffmpeg and put it on PATH, or set ' +
  'FFMPEG_PATH to it.';

// DirectShow's own buffering, in milliseconds. Left at the device default this
// is whatever the driver feels like, commonly several hundred — audible lag
// when an operator is listening to a mic to decide whether it is the one
// crackling.
const DSHOW_BUFFER_MS = '80';

class DshowBackend implements CaptureBackend {
  readonly id = 'dshow' as const;
  readonly label = 'Windows (DirectShow)';

  available(): boolean { return resolveFfmpeg() !== null; }
  unavailableReason(): string { return FFMPEG_MISSING; }

  listDevices(): AudioInputDevice[] {
    const out = runFfmpeg(['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    return parseDshowDevices(out).map((name, i) => ({
      // The name IS the address in dshow, so it goes in the id — a patch
      // stored against it keeps working as long as the device is called the
      // same thing.
      id: `dshow:${name}`,
      label: name,
      card: i,
      device: 0,
      channels: 0,
      channelsProbed: false,
    }));
  }

  probeChannels(deviceId: string): number | null {
    const name = deviceId.replace(/^dshow:/, '');
    const out = runFfmpeg([
      '-hide_banner', '-list_options', 'true', '-f', 'dshow', '-i', `audio=${name}`,
    ]);
    return parseDshowChannels(out);
  }

  captureCommand(deviceId: string, channels: number, rate: number): CaptureCommand {
    const name = deviceId.replace(/^dshow:/, '');
    return {
      command: resolveFfmpeg() ?? 'ffmpeg',
      args: [
        '-hide_banner', '-loglevel', 'error',
        // Input options. -channels opens the device at its real width; without
        // it DirectShow hands over its own default, and a 16-input interface
        // would arrive as two channels no matter what was patched.
        '-f', 'dshow',
        '-channels', String(channels),
        '-audio_buffer_size', DSHOW_BUFFER_MS,
        '-i', `audio=${name}`,
        // Output options: resample and re-lay-out to what RTCAudioSource and
        // the recorder expect. Devices that cannot do 48 kHz natively — most
        // built-in inputs stop at 44.1 — are converted here rather than
        // failing to open.
        '-ac', String(channels), '-ar', String(rate),
        '-f', 's16le', '-acodec', 'pcm_s16le', '-',
      ],
    };
  }
}

// ── macOS ───────────────────────────────────────────────────────────────────

class AvFoundationBackend implements CaptureBackend {
  readonly id = 'avfoundation' as const;
  readonly label = 'macOS (AVFoundation)';

  available(): boolean { return resolveFfmpeg() !== null; }
  unavailableReason(): string { return FFMPEG_MISSING; }

  listDevices(): AudioInputDevice[] {
    const out = runFfmpeg(['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    return parseAvfoundationDevices(out).map(d => ({
      id: `av:${d.index}`,
      label: d.name,
      card: d.index,
      device: 0,
      channels: 0,
      channelsProbed: false,
    }));
  }

  probeChannels(): number | null {
    // AVFoundation does not advertise a channel count before the stream opens,
    // and guessing one is how a 16-channel interface silently became stereo on
    // Linux. Unknown is reported as unknown; the UI says so.
    return null;
  }

  captureCommand(deviceId: string, channels: number, rate: number): CaptureCommand {
    const index = deviceId.replace(/^av:/, '');
    return {
      command: resolveFfmpeg() ?? 'ffmpeg',
      args: [
        '-hide_banner', '-loglevel', 'error',
        // ":N" is how AVFoundation is told "audio device N, and no video".
        '-f', 'avfoundation', '-i', `:${index}`,
        '-ac', String(channels), '-ar', String(rate),
        '-f', 's16le', '-acodec', 'pcm_s16le', '-',
      ],
    };
  }
}

// ── Linux ───────────────────────────────────────────────────────────────────
//
// Unchanged behaviour, moved here. ALSA is used directly rather than through
// ffmpeg: arecord is present on every server the installer touches, reports a
// real channel range, and existing patches are stored against its hw:X,Y ids.

class AlsaBackend implements CaptureBackend {
  readonly id = 'alsa' as const;
  readonly label = 'Linux (ALSA)';

  available(): boolean {
    // /proc/asound is the sound subsystem itself; arecord is how we read it.
    return fs.existsSync('/proc/asound');
  }

  unavailableReason(): string {
    return 'This machine has no ALSA sound subsystem, so there are no capture devices. ' +
           'On a headless server, audio devices normally appear once the AES67 daemon ' +
           'and its kernel module are installed.';
  }

  listDevices(): AudioInputDevice[] {
    return listAlsaDevices();
  }

  probeChannels(deviceId: string): number | null {
    return probeAlsaChannels(deviceId);
  }

  captureCommand(deviceId: string, channels: number, rate: number): CaptureCommand {
    return {
      command: 'arecord',
      args: [
        '-D', deviceId,
        '-f', 'S16_LE',
        '-r', String(rate),
        '-c', String(channels),
        '-t', 'raw',
        '--buffer-size=8192',
        '-q',
      ],
    };
  }
}

// ALSA enumeration and probing, unchanged apart from where they live.

const PCM_LINE = /^(\d+)-(\d+):\s*([^:]*?)\s*:\s*([^:]*?)\s*:(.*)$/;
export const ARECORD_LINE =
  /^card\s+(\d+):\s*[^[]*\[([^\]]*)\]\s*,\s*device\s+(\d+):\s*[^[]*\[([^\]]*)\]/;

function labelFor(cardName: string, pcmName: string): string {
  return pcmName && !cardName.includes(pcmName) ? `${cardName} — ${pcmName}` : cardName;
}

function readCardNames(): Map<number, string> {
  const names = new Map<number, string>();
  try {
    const raw = fs.readFileSync('/proc/asound/cards', 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(\d+)\s*\[([^\]]+)\]\s*:\s*(.*)$/);
      if (!m) continue;
      const long = m[3]?.split(' - ').pop()?.trim();
      names.set(Number(m[1]), long || m[2].trim());
    }
  } catch { /* not Linux, or no sound subsystem */ }
  return names;
}

function listAlsaDevices(): AudioInputDevice[] {
  const merged = new Map<string, AudioInputDevice>();

  // arecord -l is canonical and reports drivers that never populate
  // /proc/asound/pcm — the RAVENNA module among them.
  let out = '';
  try {
    out = execFileSync('arecord', ['-l'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    });
  } catch (err: any) {
    out = err?.stdout ?? '';
  }
  for (const line of out.split('\n')) {
    const m = line.match(ARECORD_LINE);
    if (!m) continue;
    const card = Number(m[1]);
    const device = Number(m[3]);
    merged.set(`hw:${card},${device}`, {
      id: `hw:${card},${device}`,
      label: labelFor(m[2].trim(), m[4].trim()),
      card, device, channels: 0, channelsProbed: false,
    });
  }

  // Fallback for a machine without alsa-utils.
  try {
    const pcm = fs.readFileSync('/proc/asound/pcm', 'utf8');
    const cardNames = readCardNames();
    for (const line of pcm.split('\n')) {
      const m = line.match(PCM_LINE);
      if (!m) continue;
      if (!/capture\s+\d+/.test(m[5] ?? '')) continue;
      const card = Number(m[1]);
      const device = Number(m[2]);
      const id = `hw:${card},${device}`;
      if (merged.has(id)) continue;
      merged.set(id, {
        id,
        label: labelFor(cardNames.get(card) ?? `Card ${card}`, (m[4] || m[3] || '').trim()),
        card, device, channels: 0, channelsProbed: false,
      });
    }
  } catch { /* no /proc/asound */ }

  return [...merged.values()].sort((a, b) => a.card - b.card || a.device - b.device);
}

function probeAlsaChannels(deviceId: string): number | null {
  try {
    const out = execFileSync(
      'arecord',
      ['-D', deviceId, '--dump-hw-params', '-d', '1', '/dev/null'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 4000 },
    );
    return parseAlsaChannels(out);
  } catch (err: any) {
    return parseAlsaChannels(`${err?.stdout ?? ''}${err?.stderr ?? ''}`);
  }
}

/** "CHANNELS: 2" or "CHANNELS: [1 32]" — take the maximum the device offers. */
export function parseAlsaChannels(text: string): number | null {
  const m = text.match(/^CHANNELS:\s*(.+)$/m);
  if (!m) return null;
  const nums = m[1].match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  const max = Math.max(...nums.map(Number));
  return Number.isFinite(max) && max > 0 ? max : null;
}

// ── Selection ───────────────────────────────────────────────────────────────

const BACKENDS: Record<string, CaptureBackend> = {
  win32:  new DshowBackend(),
  darwin: new AvFoundationBackend(),
  linux:  new AlsaBackend(),
};

export function captureBackend(platform: string = process.platform): CaptureBackend {
  // Anything else is almost certainly a Unix with ALSA; better to try than to
  // refuse outright.
  return BACKENDS[platform] ?? BACKENDS.linux;
}

let announced = false;
export function announceBackend(): void {
  if (announced) return;
  announced = true;
  const b = captureBackend();
  if (b.available()) {
    log.info(`[audio] Capture backend: ${b.label}` +
             (b.id !== 'alsa' ? ` via ${resolveFfmpeg()}` : ''));
  } else {
    log.warn(`[audio] No capture backend: ${b.unavailableReason()}`);
  }
}
