import { describe, it, expect } from 'vitest';
import { parseChannels, ARECORD_LINE } from './deviceList';

// These parsers had their regex escapes stripped at some point, turning \s and
// \d into literal "s" and "d". The result was not a crash but a plausible lie:
// every device reported the 2-channel fallback regardless of real width, and a
// 64-channel RAVENNA card looked like a stereo input. Real fixture text here,
// copied from actual ALSA output, so the same silent failure cannot recur.

describe('parseChannels', () => {
  it('reads a fixed channel count', () => {
    expect(parseChannels('CHANNELS: 2')).toBe(2);
  });

  it('takes the maximum of a range', () => {
    // What a multichannel card reports — the bug made this unreachable.
    expect(parseChannels('CHANNELS: [1 64]')).toBe(64);
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
    expect(parseChannels(dump)).toBe(128);
  });

  it('returns null when there is no CHANNELS line, rather than guessing', () => {
    expect(parseChannels('arecord: device_list:277: no soundcards found...')).toBeNull();
    expect(parseChannels('')).toBeNull();
  });

  it('returns null when CHANNELS carries no number', () => {
    expect(parseChannels('CHANNELS: NONE')).toBeNull();
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
