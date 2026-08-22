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
  /** Input channels the device reports. Probed, never assumed. */
  channels: number;
}

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

export function listAudioInputDevices(): AudioInputDevice[] {
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

    // Only capture-capable devices are useful here; playback-only ones would
    // just be noise in the picker.
    const capabilities = m[5] ?? '';
    if (!/capture\s+\d+/.test(capabilities)) continue;

    const card = Number(m[1]);
    const device = Number(m[2]);
    const pcmName = (m[4] || m[3] || '').trim();
    const cardName = cardNames.get(card) ?? `Card ${card}`;

    // Avoid "Scarlett — Scarlett" when ALSA repeats itself.
    const label = pcmName && !cardName.includes(pcmName)
      ? `${cardName} — ${pcmName}`
      : cardName;

    const id = `hw:${card},${device}`;
    devices.push({ id, label, card, device, channels: probeChannelCount(id) });
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
const channelCache = new Map<string, number>();

export function probeChannelCount(deviceId: string): number {
  const cached = channelCache.get(deviceId);
  if (cached !== undefined) return cached;

  let channels = 2; // sane floor if the probe tells us nothing
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
      log.debug(`[audio] Could not probe channel count for ${deviceId}; assuming ${channels}`);
    }
  }

  channelCache.set(deviceId, channels);
  return channels;
}

// "CHANNELS: 2" or "CHANNELS: [1 32]" — take the maximum the device offers.
function parseChannels(text: string): number | null {
  const m = text.match(/^CHANNELS:s*(.+)$/m);
  if (!m) return null;
  const nums = m[1].match(/d+/g);
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

export function describeNoDevices(): string {
  if (!audioSubsystemPresent()) {
    return 'This machine has no ALSA sound subsystem, so there are no capture devices. ' +
           'On a headless server, audio devices normally appear once the AES67 daemon ' +
           'and its kernel module are installed.';
  }
  return 'No capture devices found. Check that the interface is connected, and that ' +
         'the AES67 kernel module is loaded (lsmod | grep MergingRavenna).';
}
