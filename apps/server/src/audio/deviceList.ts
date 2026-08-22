import fs from 'fs';
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
  /** Channels the device reports, when ALSA tells us. */
  channels?: number;
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

    devices.push({ id: `hw:${card},${device}`, label, card, device });
  }

  return devices;
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
