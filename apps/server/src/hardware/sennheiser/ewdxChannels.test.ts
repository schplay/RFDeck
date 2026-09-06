import { describe, it, expect, vi } from 'vitest';
import { SSCClient } from './SSCClient';

// A channel exists whether or not the receiver has said what it is called.
//
// The label on a channel belongs to the hardware. It is not RFDeck's, it can
// change at any time, and it is for display — so nothing about whether a
// channel appears, or whether a device is reported as connected, may depend on
// it having arrived.
//
// A previous version withheld every channel until its name was known, to stop
// a card going up under a fallback label and being renamed a second later. The
// wait had no bound, and a channel reporting no name never satisfied it: a
// working receiver produced no channels and never came online, for the life of
// the process, while the G3s beside it were unaffected. The suite stayed green
// throughout, because nothing exercised this path.

// mergeEwdxState is where the per-channel SSE events accumulate, and where the
// regression lived. Reaching it directly keeps the test on the rule rather than
// on a stream parser.
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

describe('a channel the receiver has not named', () => {
  it('is still reported', () => {
    const { client, states } = makeClient();
    merge(client, 0, { rf_quality: 82, af_level: -20 });
    expect(states).toHaveLength(1);
    expect(states[0].rx1).toBeTruthy();
    expect(states[0].rx1.rf_quality).toBe(82);
  });

  it('still reports the device connected', () => {
    // The emit that marks the device online sits on this same path, so
    // withholding the channel withheld that too — which is why the inventory
    // card stayed red with the receiver working perfectly.
    const { client, connects } = makeClient();
    merge(client, 0, { rf_quality: 82 });
    expect(connects).toHaveBeenCalledOnce();
    expect(client.isConnected).toBe(true);
  });

  it('is reported when the name is explicitly null, not merely absent', () => {
    // How a receiver reports an unnamed channel: the field is present and null.
    // The accumulator drops nulls, so this must never be mistaken for "not yet
    // known" and waited on.
    const { client, states } = makeClient();
    merge(client, 0, { name: null, mute: false });
    expect(states).toHaveLength(1);
  });

  it('does not borrow a sibling channel name', () => {
    const { client, states } = makeClient();
    merge(client, 0, { name: 'Vocal 1' });
    merge(client, 1, { rf_quality: 40 });
    expect(states.at(-1).rx2).toBeTruthy();
    expect(states.at(-1).rx2.name).toBeNull();
  });
});

describe('a channel the receiver has named', () => {
  it('carries the name the device reported, unchanged', () => {
    const { client, states } = makeClient();
    merge(client, 0, { name: 'Vocal 1', mute: false });
    expect(states.at(-1).rx1.name).toBe('Vocal 1');
  });

  it('follows the device when the device renames it', () => {
    // The label is the hardware's and may change at any time. RFDeck reports
    // what the receiver currently says rather than holding on to what it said
    // before.
    const { client, states } = makeClient();
    merge(client, 0, { name: 'Vocal 1' });
    merge(client, 0, { name: 'Vocal 2' });
    expect(states.at(-1).rx1.name).toBe('Vocal 2');
  });
});
