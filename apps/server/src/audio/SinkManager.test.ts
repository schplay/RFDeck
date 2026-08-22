import { describe, it, expect } from 'vitest';
import { SinkManager } from './SinkManager';
import type { DaemonSink, RemoteSource } from './AES67DaemonClient';

// Channel allocation is the part worth testing hardest: two sinks sharing a
// channel produce audio that flips between two senders, which sounds like a
// failing receiver rather than a configuration fault, and would be diagnosed
// as such at the worst possible moment.

const SDP_8CH = [
  'v=0',
  'o=- 1311738121 1311738121 IN IP4 192.168.1.60',
  's=AES67 Stagebox A',
  'c=IN IP4 239.1.0.1/15',
  't=0 0',
  'm=audio 5004 RTP/AVP 98',
  'a=rtpmap:98 L24/48000/8',
  'a=sync-time:0',
].join('\n');

const SDP_MONO = [
  'v=0',
  'o=- 992 992 IN IP4 192.168.1.70',
  's=Handheld 1',
  'm=audio 5004 RTP/AVP 98',
  'a=rtpmap:98 L24/48000',
].join('\n');

const source = (sdp: string, id = 'x'): RemoteSource =>
  ({ id, name: '', source: 'sap', sdp } as RemoteSource);

describe('channelCountFromSdp', () => {
  it('reads a multichannel count', () => {
    expect(SinkManager.channelCountFromSdp(SDP_8CH)).toBe(8);
  });

  it('treats a missing trailing field as mono, per RFC 4566', () => {
    expect(SinkManager.channelCountFromSdp(SDP_MONO)).toBe(1);
  });

  it('returns null rather than guessing when there is no rtpmap', () => {
    // Callers must refuse to allocate rather than reserve an invented width.
    expect(SinkManager.channelCountFromSdp('v=0\ns=nothing useful')).toBeNull();
  });
});

describe('allocate', () => {
  it('takes the lowest free block', () => {
    expect(SinkManager.allocate(new Set(), 4, 128)).toEqual([0, 1, 2, 3]);
  });

  it('skips past channels already in use', () => {
    const taken = new Set([0, 1, 2, 3]);
    expect(SinkManager.allocate(taken, 2, 128)).toEqual([4, 5]);
  });

  it('never overlaps an existing allocation', () => {
    const taken = new Set([2, 3]);
    const got = SinkManager.allocate(taken, 2, 128)!;
    expect(got.some(c => taken.has(c))).toBe(false);
  });

  it('fills a gap left by a removed subscription', () => {
    // 0-1 and 4-5 in use; a stereo sender should reuse 2-3 rather than append.
    const taken = new Set([0, 1, 4, 5]);
    expect(SinkManager.allocate(taken, 2, 128)).toEqual([2, 3]);
  });

  it('requires the block to be contiguous', () => {
    // Only 1 and 3 free below 4 — a stereo sender cannot use them.
    const taken = new Set([0, 2, 4]);
    expect(SinkManager.allocate(taken, 2, 8)).toEqual([5, 6]);
  });

  it('returns null when the device has no room', () => {
    const taken = new Set([0, 1]);
    expect(SinkManager.allocate(taken, 4, 4)).toBeNull();
  });

  it('does not run off the end of the device', () => {
    expect(SinkManager.allocate(new Set(), 8, 4)).toBeNull();
  });
});

describe('isSubscribedTo', () => {
  const sink = (sdp: string): DaemonSink =>
    ({ id: 0, name: 's', io: 'Audio Device', use_sdp: true, sdp, map: [0] } as DaemonSink);

  it('matches a sink to its sender by SDP originator', () => {
    expect(SinkManager.isSubscribedTo(sink(SDP_8CH), source(SDP_8CH))).toBe(true);
  });

  it('does not match different senders', () => {
    expect(SinkManager.isSubscribedTo(sink(SDP_8CH), source(SDP_MONO))).toBe(false);
  });

  it('still matches when the sender has changed address', () => {
    // Same originator line, readvertised from a new address — the daemon pairs
    // on o=, so re-subscribing would create a duplicate fighting for channels.
    const moved = SDP_8CH.replace('c=IN IP4 239.1.0.1/15', 'c=IN IP4 239.1.0.9/15');
    expect(SinkManager.isSubscribedTo(sink(SDP_8CH), source(moved))).toBe(true);
  });

  it('does not match when either side has no originator', () => {
    expect(SinkManager.isSubscribedTo(sink('v=0'), source(SDP_8CH))).toBe(false);
  });
});

describe('sourceName', () => {
  it('prefers the announced name', () => {
    expect(SinkManager.sourceName({ ...source(SDP_8CH), name: 'Booth A' } as RemoteSource))
      .toBe('Booth A');
  });

  it('falls back to the SDP session name', () => {
    expect(SinkManager.sourceName(source(SDP_8CH))).toBe('AES67 Stagebox A');
  });
});
