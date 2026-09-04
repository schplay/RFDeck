import { describe, it, expect } from 'vitest';
import {
  parseAlsaChannels,
  parseDshowDevices,
  parseDshowChannels,
  parseAvfoundationDevices,
  ARECORD_LINE,
  captureBackend,
  runTool,
} from './backends';

// Every parser here has already shipped broken once, in the same way both
// times: written against remembered output, never run against a real binary.
// The ALSA one lost its regex escapes and reported 2 channels for a 64-channel
// card; the DirectShow one expected section headings that ffmpeg stopped
// printing years ago and found no devices at all.
//
// So the fixtures below are verbatim captures, not paraphrases.

describe('parseAlsaChannels', () => {
  it('reads a fixed channel count', () => {
    expect(parseAlsaChannels('CHANNELS: 2')).toBe(2);
  });

  it('takes the maximum of a range', () => {
    // What a multichannel card reports — the escape bug made this unreachable.
    expect(parseAlsaChannels('CHANNELS: [1 64]')).toBe(64);
  });

  it('finds CHANNELS among the surrounding hw_params dump', () => {
    const dump = [
      'HW Params of device "hw:2,0":',
      '--------------------',
      'ACCESS:  MMAP_INTERLEAVED RW_INTERLEAVED',
      'FORMAT:  S16_LE S32_LE',
      'CHANNELS: [1 128]',
      'RATE: [44100 192000]',
      'PERIOD_SIZE: [16 8192]',
    ].join('\n');
    expect(parseAlsaChannels(dump)).toBe(128);
  });

  it('returns null when there is no CHANNELS line, rather than guessing', () => {
    expect(parseAlsaChannels('arecord: device_list:277: no soundcards found...')).toBeNull();
    expect(parseAlsaChannels('')).toBeNull();
  });

  it('returns null when CHANNELS carries no number', () => {
    expect(parseAlsaChannels('CHANNELS: NONE')).toBeNull();
  });
});

describe('ARECORD_LINE', () => {
  it('parses the RAVENNA device the AES67 daemon creates', () => {
    const m = 'card 2: RAVENNA [RAVENNA], device 0: RAVENNA [RAVENNA]'.match(ARECORD_LINE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('2');
    expect(m![2]).toBe('RAVENNA');
    expect(m![3]).toBe('0');
  });

  it('parses an ALSA id containing spaces', () => {
    // "ALC257 Analog" — a single-token pattern silently dropped these.
    const line = 'card 0: PCH [HDA Intel PCH], device 0: ALC257 Analog [ALC257 Analog]';
    const m = line.match(ARECORD_LINE);
    expect(m).not.toBeNull();
    expect(m![2]).toBe('HDA Intel PCH');
    expect(m![4]).toBe('ALC257 Analog');
  });

  it('ignores the surrounding subdevice lines', () => {
    expect('  Subdevices: 1/1'.match(ARECORD_LINE)).toBeNull();
    expect('  Subdevice #0: subdevice #0'.match(ARECORD_LINE)).toBeNull();
  });
});

// Captured from ffmpeg 6.1.1 on Windows 11:
//   ffmpeg -hide_banner -list_devices true -f dshow -i dummy
// Note there are no "DirectShow audio devices" headings — each entry carries a
// (video)/(audio)/(none) tag instead. A machine with NDI and OBS installed
// offers plenty of things that must not be presented as microphones.
const DSHOW_DEVICES_611 = `
[dshow @ 000001e9d732bf00] "Sony Camera (Imaging Edge)" (video)
[dshow @ 000001e9d732bf00]   Alternative name "@device_pnp_\\\\?\\root#imagingedgewebcam#0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\customcamerasource"
[dshow @ 000001e9d732bf00] "NDI Webcam Video 1" (video)
[dshow @ 000001e9d732bf00]   Alternative name "@device_pnp_\\\\?\\root#media#0002#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\vidsource0"
[dshow @ 000001e9d732bf00] "OBS Virtual Camera" (none)
[dshow @ 000001e9d732bf00]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[dshow @ 000001e9d732bf00] "Webcam 4 (NDI Webcam Audio)" (audio)
[dshow @ 000001e9d732bf00]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{0C99454A-613C-4883-A490-924E75F1EE2C}"
[dshow @ 000001e9d732bf00] "Microphone (Steam Streaming Microphone)" (audio)
[dshow @ 000001e9d732bf00]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{CC555441-6066-4236-A2F2-0A45745FDC26}"
[dshow @ 000001e9d732bf00] "Microphone (Realtek(R) Audio Codec with DolbyAPO)" (audio)
[dshow @ 000001e9d732bf00]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{F0EC9574-4F5C-4817-B85F-7A2F459A8FC0}"
[in#0 @ 000001e9d732bdc0] Error opening input: Immediate exit requested
Error opening input file dummy.
`;

// The pre-5.x shape, kept because a machine with its own ffmpeg on PATH may
// well have an older one.
const DSHOW_DEVICES_LEGACY = `
[dshow @ 0000000] DirectShow video devices (some may be both video and audio devices)
[dshow @ 0000000]  "Integrated Camera"
[dshow @ 0000000]     Alternative name "@device_pnp_\\\\?\\usb#vid_04f2"
[dshow @ 0000000] DirectShow audio devices
[dshow @ 0000000]  "Microphone (Realtek High Definition Audio)"
[dshow @ 0000000]     Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{ABCD}"
`;

describe('parseDshowDevices', () => {
  it('takes only the audio-tagged entries from ffmpeg 6.x', () => {
    expect(parseDshowDevices(DSHOW_DEVICES_611)).toEqual([
      'Webcam 4 (NDI Webcam Audio)',
      'Microphone (Steam Streaming Microphone)',
      'Microphone (Realtek(R) Audio Codec with DolbyAPO)',
    ]);
  });

  it('does not offer a camera as an input', () => {
    const found = parseDshowDevices(DSHOW_DEVICES_611);
    expect(found).not.toContain('Sony Camera (Imaging Edge)');
    expect(found).not.toContain('OBS Virtual Camera');
    expect(found).not.toContain('NDI Webcam Video 1');
  });

  it('never returns an "Alternative name" line as a device', () => {
    for (const d of parseDshowDevices(DSHOW_DEVICES_611)) {
      expect(d).not.toMatch(/^@device_/);
    }
  });

  it('still reads the older heading-grouped listing', () => {
    expect(parseDshowDevices(DSHOW_DEVICES_LEGACY))
      .toEqual(['Microphone (Realtek High Definition Audio)']);
  });

  it('returns nothing for output with no devices at all', () => {
    expect(parseDshowDevices('')).toEqual([]);
  });
});

// Captured from the same binary:
//   ffmpeg -hide_banner -list_options true -f dshow -i "audio=Microphone (...)"
// The space after "ch=" is what the first version of this parser missed.
const DSHOW_OPTIONS_611 = `
[dshow @ 00000152b1adbf00] DirectShow audio only device options (from audio devices)
[dshow @ 00000152b1adbf00]  Pin "Capture" (alternative pin name "Capture")
[dshow @ 00000152b1adbf00]   ch= 2, bits=16, rate= 44100
    Last message repeated 1 times
[dshow @ 00000152b1adbf00]   ch= 1, bits=16, rate= 44100
[dshow @ 00000152b1adbf00]   ch= 2, bits=16, rate= 32000
[dshow @ 00000152b1adbf00]   ch= 1, bits= 8, rate=  8000
`;

describe('parseDshowChannels', () => {
  it('reads the widest format a real device offers', () => {
    expect(parseDshowChannels(DSHOW_OPTIONS_611)).toBe(2);
  });

  it('reads a multichannel interface rather than capping it', () => {
    // A 16-in Dante or MADI card. Getting this wrong is the failure that
    // silently made every extra input unpatchable on Linux.
    const wide = '[dshow @ 0]   ch= 16, bits=24, rate= 48000\n[dshow @ 0]   ch= 2, bits=16, rate= 48000';
    expect(parseDshowChannels(wide)).toBe(16);
  });

  it('reads the pre-5.x min/max line', () => {
    const legacy = '[dshow @ 0]   min ch=1 bits=8 rate= 11025 max ch=8 bits=16 rate= 44100';
    expect(parseDshowChannels(legacy)).toBe(8);
  });

  it('returns null rather than a plausible default when nothing matches', () => {
    expect(parseDshowChannels('Could not find audio only device')).toBeNull();
    expect(parseDshowChannels('')).toBeNull();
  });

  it('is not fooled by a rate that happens to contain "ch"', () => {
    expect(parseDshowChannels('[dshow @ 0] switch=4')).toBeNull();
  });
});

describe('parseAvfoundationDevices', () => {
  // avfoundation.m prints "[%d] %s  [uid:%s] [serial:%s]" on current ffmpeg.
  const LISTING = `
[AVFoundation indev @ 0x7f8e1] AVFoundation video devices:
[AVFoundation indev @ 0x7f8e1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f8e1] [1] Capture screen 0
[AVFoundation indev @ 0x7f8e1] AVFoundation audio devices:
[AVFoundation indev @ 0x7f8e1] [0] Built-in Microphone  [uid:BuiltInMicrophoneDevice]
[AVFoundation indev @ 0x7f8e1] [1] Scarlett 18i20 USB  [uid:0x14100000-1235] [serial:S9A7B2]
`;

  it('takes the audio section and leaves the cameras alone', () => {
    expect(parseAvfoundationDevices(LISTING)).toEqual([
      { index: 0, name: 'Built-in Microphone' },
      { index: 1, name: 'Scarlett 18i20 USB' },
    ]);
  });

  it('strips the uid and serial annotations from the name', () => {
    const [first] = parseAvfoundationDevices(LISTING);
    expect(first.name).not.toMatch(/uid:/);
  });

  it('reads the older bare-name form', () => {
    const older = [
      '[AVFoundation indev @ 0x1] AVFoundation audio devices:',
      '[AVFoundation indev @ 0x1] [0] Built-in Microphone',
    ].join('\n');
    expect(parseAvfoundationDevices(older)).toEqual([{ index: 0, name: 'Built-in Microphone' }]);
  });

  it('returns nothing when there is no audio section', () => {
    expect(parseAvfoundationDevices('[AVFoundation indev @ 0x1] AVFoundation video devices:\n[AVFoundation indev @ 0x1] [0] FaceTime HD Camera')).toEqual([]);
  });
});

// ffmpeg prints its device listing to stderr — it is log output, not program
// output — and against 6.1.1 it does so while exiting 0 with stdout empty. The
// first version of this used execFileSync, which returns stdout alone on
// success, so enumeration came back empty on a machine with six working
// inputs and Windows reported "no capture devices". Node stands in for ffmpeg
// here because the assertion is about which streams are collected, not about
// ffmpeg.
describe('runTool', () => {
  it('collects stderr even when the tool exits successfully', () => {
    const out = runTool(process.execPath, ['-e', 'console.error("on stderr"); process.exit(0)']);
    expect(out).toContain('on stderr');
  });

  it('collects stderr when the tool exits non-zero', () => {
    const out = runTool(process.execPath, ['-e', 'console.error("still wanted"); process.exit(1)']);
    expect(out).toContain('still wanted');
  });

  it('collects stdout as well', () => {
    const out = runTool(process.execPath, ['-e', 'console.log("on stdout")']);
    expect(out).toContain('on stdout');
  });

  it('returns empty rather than throwing when the binary is not there', () => {
    expect(runTool('definitely-not-a-real-binary-xyz', ['--help'])).toBe('');
  });
});

describe('captureBackend', () => {
  it('picks a backend per platform', () => {
    expect(captureBackend('win32').id).toBe('dshow');
    expect(captureBackend('darwin').id).toBe('avfoundation');
    expect(captureBackend('linux').id).toBe('alsa');
  });

  it('falls back to ALSA on an unknown Unix rather than refusing', () => {
    expect(captureBackend('freebsd').id).toBe('alsa');
  });

  it('builds a dshow command that opens the device at its real width', () => {
    const { args } = captureBackend('win32').captureCommand('dshow:Mic (Thing)', 16, 48000);
    // -channels is an *input* option: it must come before -i or DirectShow
    // hands over its own default layout.
    const channelsAt = args.indexOf('-channels');
    const inputAt = args.indexOf('-i');
    expect(channelsAt).toBeGreaterThan(-1);
    expect(channelsAt).toBeLessThan(inputAt);
    expect(args[channelsAt + 1]).toBe('16');
    expect(args[inputAt + 1]).toBe('audio=Mic (Thing)');
    expect(args.slice(-4)).toEqual(['s16le', '-acodec', 'pcm_s16le', '-']);
  });

  it('builds an avfoundation command addressing audio only', () => {
    const { args } = captureBackend('darwin').captureCommand('av:2', 2, 48000);
    expect(args[args.indexOf('-i') + 1]).toBe(':2');
  });

  it('keeps the ALSA command and its hw: ids unchanged', () => {
    const { command, args } = captureBackend('linux').captureCommand('hw:2,0', 64, 48000);
    expect(command).toBe('arecord');
    expect(args[args.indexOf('-D') + 1]).toBe('hw:2,0');
    expect(args[args.indexOf('-c') + 1]).toBe('64');
  });
});
