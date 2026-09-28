import { describe, it, expect } from 'vitest';
import { chooseByName } from './DeviceManagerService';

// Recognising a G3/G4 by the name it reports.
//
// This is not a convenience, it is the only other identity these devices offer.
// MCP carries no serial and no identifier. The MAC comes from the OS neighbour
// table and is only ever written to an inventory row when the device connects at
// the address that row already names — so the first time a receiver changes
// address before it has been recorded, the cycle closes: it cannot be matched
// without a MAC, cannot be given one without connecting, cannot connect until its
// row has the right address, and the row only gets that by being matched.
// Eleven receivers switched off overnight came back and none could be recognised.
//
// Name matching was removed once for a real reason — a relabelled unit could be
// adopted onto another unit's record and take its history and patch with it — and
// removing it left nothing at all. These pin the conditions that make that
// impossible while keeping the recovery.

const row = (name: string, ip: string) => ({ name, ip, port: 53212 });
const noneConnected = () => false;

describe('when it recognises a device', () => {
  it('matches a single unidentified row with that name', () => {
    expect(chooseByName('Vocal 1', [row('Vocal 1', '10.2.3.5')], noneConnected).match?.ip)
      .toBe('10.2.3.5');
  });

  it('ignores case and stray whitespace, which an operator will not have matched exactly', () => {
    expect(chooseByName('  vocal 1 ', [row('Vocal 1', '10.2.3.5')], noneConnected).match?.ip)
      .toBe('10.2.3.5');
  });

  it('is not confused by a same-named device that is already connected', () => {
    // A connected device cannot also be the thing that just appeared elsewhere,
    // so it is not a candidate and does not make the choice ambiguous.
    const rows = [row('Vocal 1', '10.2.3.5'), row('Vocal 1', '10.2.3.6')];
    const connected = (d: { ip: string }) => d.ip === '10.2.3.6';
    expect(chooseByName('Vocal 1', rows, connected).match?.ip).toBe('10.2.3.5');
  });
});

describe('the bounds that make it safe', () => {
  it('refuses when two offline devices share the name', () => {
    // The dangerous case, and the reason this was removed before. Picking one is
    // a coin toss that moves a device's history onto the wrong hardware.
    const rows = [row('Vocal 1', '10.2.3.5'), row('Vocal 1', '10.2.3.6')];
    const out = chooseByName('Vocal 1', rows, noneConnected);
    expect(out.match).toBeUndefined();
    expect(out.reason).toMatch(/too ambiguous/i);
  });

  it('refuses the discovery placeholder, which is the address in disguise', () => {
    // The exact strings seen in the field. Treating these as names would make
    // every unnamed receiver on the network look like the same device.
    for (const placeholder of [
      'Sennheiser G3/G4 (10.2.4.241)',
      'Sennheiser Ge/G4 (10.2.4.241)',
      'Unknown Model',
    ]) {
      const out = chooseByName(placeholder, [row(placeholder, '10.2.3.5')], noneConnected);
      expect(out.match, placeholder).toBeUndefined();
      expect(out.reason, placeholder).toMatch(/placeholder/i);
    }
  });

  it('refuses a device that reports no name at all', () => {
    expect(chooseByName(undefined, [row('Vocal 1', '10.2.3.5')], noneConnected).match).toBeUndefined();
    expect(chooseByName('   ', [row('Vocal 1', '10.2.3.5')], noneConnected).match).toBeUndefined();
  });

  it('refuses when nothing carries that name', () => {
    const out = chooseByName('Vocal 9', [row('Vocal 1', '10.2.3.5')], noneConnected);
    expect(out.match).toBeUndefined();
    expect(out.reason).toMatch(/no unidentified device is called/i);
  });

  it('always explains a refusal, so it is never silently nothing', () => {
    for (const out of [
      chooseByName(undefined, [], noneConnected),
      chooseByName('Vocal 9', [row('Vocal 1', '10.2.3.5')], noneConnected),
      chooseByName('Vocal 1', [row('Vocal 1', '10.2.3.5')], () => true),
    ]) {
      expect(out.reason).toBeTruthy();
    }
  });
});
