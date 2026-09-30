import { describe, it, expect } from 'vitest';
import { resolveDiscoveryDisabled } from './DiscoveryService';

// Finding receivers is the one thing RFDeck cannot be talked out of.
//
// The test harness needs discovery off, because broadcasting and sweeping a
// subnet on every run is slow, noisy and dependent on whatever else is plugged
// in. That need is real and it is the harness's, not a deployment's — and it
// was originally met with an ambient environment variable read from inside
// DiscoveryService, which meant one stray variable in a service environment
// could silently stop a show rig finding its receivers.

describe('the discovery kill switch', () => {
  it('is off unless something asks for it', () => {
    expect(resolveDiscoveryDisabled({})).toBe(false);
  });

  it('works for the test harness', () => {
    expect(resolveDiscoveryDisabled({ RFDECK_DISABLE_DISCOVERY: '1' })).toBe(true);
  });

  it('is honoured on a production server, because that is where it is needed', () => {
    // This asserted the opposite, and the reasoning was that a deployment which
    // cannot find receivers is not a state reachable by accident. True, and beside
    // the point: discovery sends traffic to addresses that are not RFDeck's, and
    // when it went wrong it degraded a venue's entire network. Because this was
    // refused in production, the only way to stop it was to kill the service —
    // which also stopped monitoring the show.
    //
    // An operator needs a lever between "my network is unusable" and "I have no
    // monitoring". The protection that matters is that it is loud, not that it is
    // unavailable.
    expect(resolveDiscoveryDisabled({
      RFDECK_DISABLE_DISCOVERY: '1',
      NODE_ENV: 'production',
    })).toBe(true);
  });

  it('ignores any value other than an exact opt-in', () => {
    for (const v of ['0', 'true', 'yes', '', 'TRUE']) {
      expect(resolveDiscoveryDisabled({ RFDECK_DISABLE_DISCOVERY: v })).toBe(false);
    }
  });
});
