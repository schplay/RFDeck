import { describe, it, expect, vi } from 'vitest';
import { SSCClient } from './SSCClient';

// An EW-DX channel must reach the dashboard whether or not it has a name.
//
// A previous fix withheld every channel until its name was known, to stop a
// card going up under a fallback label and being renamed a second later. The
// wait had no bound, and a channel reporting no name never satisfied it — so a
// working receiver produced no channels and never reported connected, for the
// life of the process, while the G3s beside it were unaffected. The whole test
// suite stayed green through all of it, because nothing exercised this path.
//
// These are the assertions that would have caught it. They are about the rule,
// not the mechanism: a name may change what a channel is *called* and must
// never decide whether it exists.

// mergeEwdxState is the accumulation point for the per-channel SSE events.
// Reaching it directly keeps the test on the rule under test rather than on a
// stream parser, and it is the exact function the regression lived in.
function merge(client: SSCClient, chId: number, update: Record<string, unknown>) {
  (client as any).mergeEwdxState(chId, update);
}

function makeClient() {
  const client = new SSCClient('192.0.2.10', 443, null);
  const states: any[] = [];
  const connects = vi.fn();
  client.on('state', (s: any) => states.push(s));
  client.on('connected', connects);
  return { client, states, connects };
}

describe('an EW-DX channel that reports no name', () => {
  it('is still announced', () => {
    const { client, states } = makeClient();
    merge(client, 0, { rf_quality: 82, af_level: -20 });
    expect(states).toHaveLength(1);
    expect(states[0].rx1).toBeTruthy();
    expect(states[0].rx1.rf_quality).toBe(82);
  });

  it('still reports the device connected', () => {
    // The emit that marks the device online sits on this same path. Withholding
    // the channel withheld that too, which is why the card stayed red.
    const { client, connects } = makeClient();
    merge(client, 0, { rf_quality: 82 });
    expect(connects).toHaveBeenCalledOnce();
    expect(client.isConnected).toBe(true);
  });

  it('is announced when the name is explicitly null, not merely absent', () => {
    // How a real receiver reports an unnamed channel: the field is present and
    // null. The merge drops nulls, so this must not be mistaken for "not yet
    // known" and waited on.
    const { client, states } = makeClient();
    merge(client, 0, { name: null, mute: false });
    expect(states).toHaveLength(1);
  });
});

describe('a name, once learned', () => {
  it('labels the channel', () => {
    const { client, states } = makeClient();
    merge(client, 0, { name: 'Vocal 1', mute: false });
    expect(states.at(-1).rx1.name).toBe('Vocal 1');
  });

  it('survives the connection dropping, so a reconnect is not a rename', () => {
    // The flap the original fix was aimed at. Telemetry is cleared on a drop
    // because stale readings must never show as current; the name is not a
    // reading, and keeping it is what removes the rename entirely — with
    // nothing to wait for.
    const { client, states } = makeClient();
    merge(client, 0, { name: 'Vocal 1' });

    // What a dropped connection does to the per-channel telemetry cache.
    (client as any).ewdxChannelCache.clear();

    // On reconnect the metrics arrive before the channel resource does.
    merge(client, 0, { rf_quality: 77 });

    const latest = states.at(-1).rx1;
    expect(latest.rf_quality).toBe(77);
    expect(latest.name).toBe('Vocal 1');
  });

  it('is forgotten when the device is untracked', () => {
    // Stopping is deliberate: the next tracking session must learn the device
    // afresh rather than inheriting a label from a receiver that may since have
    // been reconfigured or replaced at that address.
    const { client } = makeClient();
    merge(client, 0, { name: 'Vocal 1' });
    client.stopPolling();
    expect((client as any).ewdxNames.size).toBe(0);
  });

  it('does not leak between channels', () => {
    const { client, states } = makeClient();
    merge(client, 0, { name: 'Vocal 1' });
    merge(client, 1, { rf_quality: 40 });
    // Unnamed, and normalised to null on the way out — but present, which is
    // the whole point: it is a channel, it just has no label of its own yet.
    expect(states.at(-1).rx2).toBeTruthy();
    expect(states.at(-1).rx2.name).toBeNull();
  });
});
