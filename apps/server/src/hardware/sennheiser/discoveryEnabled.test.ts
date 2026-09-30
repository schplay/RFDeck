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

  it('is refused on a production server, however it got set', () => {
    // Inherited from a parent process, copied into a service file, exported in
    // a shell while debugging something else — it does not matter which. A
    // deployment that cannot find receivers is not a state reachable by
    // accident.
    expect(resolveDiscoveryDisabled({
      RFDECK_DISABLE_DISCOVERY: '1',
      NODE_ENV: 'production',
    })).toBe(false);
  });

  it('ignores any value other than an exact opt-in', () => {
    for (const v of ['0', 'true', 'yes', '', 'TRUE']) {
      expect(resolveDiscoveryDisabled({ RFDECK_DISABLE_DISCOVERY: v })).toBe(false);
    }
  });
});
