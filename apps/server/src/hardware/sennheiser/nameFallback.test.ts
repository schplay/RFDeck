import { describe, it, expect } from 'vitest';
import { chooseByName } from './DeviceManagerService';

// Adopting a G3/G4 on its name.
//
// G3/G4 speak MCP, which offers no serial and no hardware id — only a label the
// operator set. So the MAC from the OS neighbour table is the only thing that can
// prove which unit a receiver is, and it can only be *recorded* while the device
// sits at the address already on its row. A receiver that moved before it was ever
// seen has no stored MAC and nothing to compare against, which is how half a rig
// ends up offline after DHCP shuffles addresses while RFDeck is off.
//
// This rule recovers exactly that case, once, and then records the MAC so it is
// never needed again for that device. Matching on a label alone used to be the
// general fallback and was removed for good reason: a relabelled receiver could be
// adopted onto another unit's record and take its history and patch with it. These
// cases pin the bounds that make this version different.

const row = (name: string, ip: string) => ({ name, ip, port: 53212 });
const noneConnected = () => false;

describe('when it adopts', () => {
  it('matches a single unidentified device with that name', () => {
    const match = chooseByName('Vocal 1', [row('Vocal 1', '10.0.0.5')], noneConnected).match;
    expect(match?.ip).toBe('10.0.0.5');
  });

  it('ignores case and surrounding whitespace, which an operator will not have matched exactly', () => {
    const match = chooseByName('  vocal 1 ', [row('Vocal 1', '10.0.0.5')], noneConnected).match;
    expect(match?.ip).toBe('10.0.0.5');
  });

  it('picks the one offline device even when a same-named one is connected', () => {
    // A connected device cannot also be the thing that just appeared elsewhere,
    // so it is not a candidate and does not make the choice ambiguous.
    const rows = [row('Vocal 1', '10.0.0.5'), row('Vocal 1', '10.0.0.6')];
    const connected = (d: { ip: string }) => d.ip === '10.0.0.6';
    expect(chooseByName('Vocal 1', rows, connected).match?.ip).toBe('10.0.0.5');
  });
});

describe('when it refuses, and why', () => {
  it('refuses when two offline devices share the name', () => {
    // The dangerous case. Picking one is a coin toss that moves a device's
    // history and patch onto the wrong hardware.
    const rows = [row('Vocal 1', '10.0.0.5'), row('Vocal 1', '10.0.0.6')];
    const out = chooseByName('Vocal 1', rows, noneConnected);
    expect(out.match).toBeUndefined();
    expect(out.reason).toMatch(/too ambiguous/i);
  });

  it('refuses a device that reports no name', () => {
    expect(chooseByName(undefined, [row('Vocal 1', '10.0.0.5')], noneConnected).match).toBeUndefined();
    expect(chooseByName('   ', [row('Vocal 1', '10.0.0.5')], noneConnected).match).toBeUndefined();
  });

  it('refuses discovery placeholders, which are not names anybody set', () => {
    // Every unnamed receiver on the network carries one of these, so treating
    // them as names would make them all look like the same device.
    for (const placeholder of ['Sennheiser G3/G4 (10.0.0.9)', 'Unknown Model', 'unknown device']) {
      const out = chooseByName(placeholder, [row(placeholder, '10.0.0.5')], noneConnected);
      expect(out.match, placeholder).toBeUndefined();
      expect(out.reason, placeholder).toMatch(/placeholder/i);
    }
  });

  it('refuses when nothing carries that name', () => {
    const out = chooseByName('Vocal 9', [row('Vocal 1', '10.0.0.5')], noneConnected);
    expect(out.match).toBeUndefined();
    expect(out.reason).toMatch(/no unidentified device is called/i);
  });

  it('refuses when the only same-named device is answering at its own address', () => {
    const out = chooseByName('Vocal 1', [row('Vocal 1', '10.0.0.5')], () => true);
    expect(out.match).toBeUndefined();
    expect(out.reason).toMatch(/already connected/i);
  });

  it('always gives a reason when it declines, so a refusal is never silent', () => {
    // "No match" with no explanation is indistinguishable from discovery being
    // broken, which is exactly how this bug presented.
    const cases = [
      chooseByName(undefined, [], noneConnected),
      chooseByName('Vocal 9', [row('Vocal 1', '10.0.0.5')], noneConnected),
      chooseByName('Vocal 1', [row('Vocal 1', '10.0.0.5')], () => true),
    ];
    for (const out of cases) expect(out.reason).toBeTruthy();
  });
});

describe('what the caller must have narrowed first', () => {
  it('trusts the candidate list, so the query is the other half of the safety', () => {
    // This function cannot see a row's MAC. The caller passes only active G3/G4
    // rows with `mac: null` at another address — a row carrying stored identity
    // must never reach here, because a name would then override real evidence.
    // Pinned as a statement of the contract rather than a behaviour.
    const match = chooseByName('Vocal 1', [row('Vocal 1', '10.0.0.5')], noneConnected).match;
    expect(match).toBeDefined();
  });
});
