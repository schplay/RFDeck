import fs from 'fs';
import { execFileSync } from 'child_process';
import { log } from '../logger';

// Audio capture devices on the machine running RFDeck.
//
// The interface with the receiver outputs is plugged into *this* machine — the
// rack server — not into whichever laptop happens to be viewing the dashboard.
// So the device list has to come from here and be offered to clients, rather
// than each browser enumerating its own hardware and monitoring the wrong room.
//
// Read from /proc/asound rather than by shelling out to `arecord`: it needs no
// package installed, cannot be defeated by locale differences in the output,
// and is stable across ALSA versions.

export interface AudioInputDevice {
  /** ALSA device string, e.g. "hw:1,0" — what capture actually opens. */
  id: string;
  /** Human label, e.g. "Scarlett 18i20 — Analog". */
  label: string;
  card: number;
  device: number;
  /** Input channels. Probed when `channelsProbed`, otherwise the fallback. */
  channels: number;
  /**
   * Whether `channels` came from the hardware or is a guess. Kept separate so a
   * failed probe cannot masquerade as a real 2-channel reading — that ambiguity
   * previously hid a parser bug behind an entirely plausible number.
   */
  channelsProbed: boolean;
}

/** Used only when the hardware will not tell us; always paired with a warning. */
export const FALLBACK_CHANNELS = 2;

// "00-00: ALC257 Analog : ALC257 Analog : playback 1 : capture 1"
const PCM_LINE = /^(\d+)-(\d+):\s*([^:]*?)\s*:\s*([^:]*?)\s*:(.*)$/;

function readCardNames(): Map<number, string> {
  const names = new Map<number, string>();
  try {
    // " 0 [PCH            ]: HDA-Intel - HDA Intel PCH"
    const raw = fs.readFileSync('/proc/asound/cards', 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(\d+)\s*\[([^\]]+)\]\s*:\s*(.*)$/);
      if (!m) continue;
      const idx = Number(m[1]);
      // Prefer the descriptive tail; fall back to the short id.
      const long = m[3]?.split(' - ').pop()?.trim();
      names.set(idx, long || m[2].trim());
    }
  } catch {
    // No /proc/asound at all — not Linux, or no sound subsystem.
  }
  return names;
}

// "card 2: RAVENNA [RAVENNA], device 0: RAVENNA [RAVENNA]"
// The ALSA id before each bracket can contain spaces ("ALC257 Analog"), so match
// up to the bracket rather than assuming a single token.
export const ARECORD_LINE =
  /^card\s+(\d+):\s*[^[]*\[([^\]]*)\]\s*,\s*device\s+(\d+):\s*[^[]*\[([^\]]*)\]/;

function labelFor(cardName: string, pcmName: string): string {
  // Avoid "RAVENNA — RAVENNA" when ALSA repeats itself.
  return pcmName && !cardName.includes(pcmName) ? `${cardName} — ${pcmName}` : cardName;
}

// Ask ALSA directly. This is the canonical listing and, unlike /proc/asound/pcm,
// it reports devices from drivers that do not populate that file — the RAVENNA
// module the AES67 daemon installs among them.
function fromArecord(): AudioInputDevice[] {
  let out = '';
  try {
    out = execFileSync('arecord', ['-l'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000,
    });
  } catch (err: any) {
    // arecord exits non-zero when there are no capture devices at all, but
    // still prints whatever it found.
    out = err?.stdout ?? '';
  }

  const devices: AudioInputDevice[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(ARECORD_LINE);
    if (!m) continue;
    const card = Number(m[1]);
    const device = Number(m[3]);
    const id = `hw:${card},${device}`;
    devices.push({ id, label: labelFor(m[2].trim(), m[4].trim()), card, device, channels: 0, channelsProbed: false });
  }
  return devices;
}

// Fallback for a machine without alsa-utils. Some drivers do not appear here,
// which is why it is not the primary source.
function fromProcAsound(): AudioInputDevice[] {
  let pcm: string;
  try {
    pcm = fs.readFileSync('/proc/asound/pcm', 'utf8');
  } catch {
    return [];
  }

  const cardNames = readCardNames();
  const devices: AudioInputDevice[] = [];

  for (const line of pcm.split('\n')) {
    const m = line.match(PCM_LINE);
    if (!m) continue;

    // Playback-only devices would just be noise in the picker.
    if (!/capture\s+\d+/.test(m[5] ?? '')) continue;

    const card = Number(m[1]);
    const device = Number(m[2]);
    const id = `hw:${card},${device}`;
    const cardName = cardNames.get(card) ?? `Card ${card}`;
    devices.push({
      id, label: labelFor(cardName, (m[4] || m[3] || '').trim()), card, device,
      channels: 0, channelsProbed: false,
    });
  }
  return devices;
}

export function listAudioInputDevices(): AudioInputDevice[] {
  // Merge both sources so a device missing from either still appears.
  const merged = new Map<string, AudioInputDevice>();
  for (const d of [...fromArecord(), ...fromProcAsound()]) {
    if (!merged.has(d.id)) merged.set(d.id, d);
  }

  const devices = [...merged.values()].sort((a, b) =>
    a.card - b.card || a.device - b.device);

  // Probe width only after de-duplicating — each probe opens the device.
  for (const d of devices) {
    const probed = probeChannelCount(d.id);
    d.channelsProbed = probed !== null;
    d.channels = probed ?? FALLBACK_CHANNELS;
  }
  return devices;
}

// How many input channels does this device actually have?
//
// There is no single answer to "how is a rig wired" — a interface might be a
// 2-channel USB box, a 32-channel Dante card, or the virtual RAVENNA device the
// AES67 daemon creates. So ask the device rather than assuming, and let the
// operator map any channel of any device.
//
// ALSA reports this through `arecord --dump-hw-params`, which prints a CHANNELS
// line that is either a single value or a range.
//
// Returns null when the hardware will not say, rather than a plausible-looking
// default — callers must decide what to do about not knowing.
const channelCache = new Map<string, number | null>();

export function probeChannelCount(deviceId: string): number | null {
  const cached = channelCache.get(deviceId);
  if (cached !== undefined) return cached;

  let channels: number | null = null;
  try {
    // Writes hw_params to stderr and exits non-zero by design, so capture both
    // and ignore the status.
    const out = execFileSync(
      'arecord',
      ['-D', deviceId, '--dump-hw-params', '-d', '1', '/dev/null'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 4000 },
    );
    channels = parseChannels(out) ?? channels;
  } catch (err: any) {
    const text = `${err?.stdout ?? ''}${err?.stderr ?? ''}`;
    const parsed = parseChannels(text);
    if (parsed !== null) {
      channels = parsed;
    } else {
      // Warn, not debug: this silently capped every device at the fallback
      // width once already, and it was invisible in the default log level.
      log.warn(
        `[audio] Could not read the channel count for ${deviceId}. ` +
        `Check "arecord -D ${deviceId} --dump-hw-params" on the server. ` +
        `Assuming ${FALLBACK_CHANNELS} inputs.`,
      );
    }
  }

  channelCache.set(deviceId, channels);
  return channels;
}

// "CHANNELS: 2" or "CHANNELS: [1 32]" — take the maximum the device offers.
export function parseChannels(text: string): number | null {
  const m = text.match(/^CHANNELS:\s*(.+)$/m);
  if (!m) return null;
  const nums = m[1].match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  const max = Math.max(...nums.map(Number));
  return Number.isFinite(max) && max > 0 ? max : null;
}

// Forget cached probes so a re-scan re-reads hardware that has changed.
export function clearChannelCache(): void {
  channelCache.clear();
}

// A quick sanity check used by the API so the UI can explain an empty list.
export function audioSubsystemPresent(): boolean {
  return fs.existsSync('/proc/asound');
}

// Can this process actually OPEN a capture device, as opposed to merely listing
// one?
//
// The two need different permissions, and that asymmetry is genuinely
// confusing: /proc/asound is world-readable, so enumeration succeeds for any
// user, while /dev/snd is group-owned by 'audio'. A service account outside
// that group therefore lists every card and can open none — which surfaced as
// devices appearing correctly but always reporting the fallback width.
//
// Tested by checking the device nodes directly rather than by matching words in
// an error message, which would break under any non-English locale.
//
// Returns null when there is nothing to test (no /dev/snd, or no capture nodes).
export function canOpenCaptureDevices(): boolean | null {
  let entries: string[];
  try {
    entries = fs.readdirSync('/dev/snd');
  } catch {
    return null;
  }

  // pcmC0D0c — card 0, device 0, 'c' for capture.
  const captureNodes = entries.filter(e => /^pcmC\d+D\d+c$/.test(e));
  if (captureNodes.length === 0) return null;

  return captureNodes.some(node => {
    try {
      fs.accessSync(`/dev/snd/${node}`, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// Explains a device list that is present but unusable. Null when nothing is wrong.
export function describeAccessProblem(): string | null {
  if (canOpenCaptureDevices() !== false) return null;
  return 'RFDeck can list capture devices but cannot open them, so channel ' +
         'counts fall back to a default and audio will not stream. The account ' +
         'running RFDeck is missing the "audio" group that owns /dev/snd. ' +
         'On the server: sudo usermod -aG audio rfdeck && sudo systemctl restart rfdeck';
}

export function describeNoDevices(): string {
  if (!audioSubsystemPresent()) {
    return 'This machine has no ALSA sound subsystem, so there are no capture devices. ' +
           'On a headless server, audio devices normally appear once the AES67 daemon ' +
           'and its kernel module are installed.';
  }
  return 'No capture devices found. Check the interface is connected and that ' +
         '"arecord -l" lists it on the server. For AES67, confirm the kernel ' +
         'module is loaded: lsmod | grep MergingRavenna';
}
