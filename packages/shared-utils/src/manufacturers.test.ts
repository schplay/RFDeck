import { describe, it, expect } from 'vitest';
import { unsupportedReason, isUnsupportedDevice } from './manufacturers';

// Devices the server must never contact, because nothing it starts for them
// could ever connect.

describe('unsupported devices', () => {
  it('names the brands RFDeck cannot talk to, whatever the case or spacing', () => {
    expect(isUnsupportedDevice('Wisycom', 'MRK960')).toBe(true);
    expect(isUnsupportedDevice('lectrosonics')).toBe(true);
    expect(unsupportedReason(' SONY ')).toBe('RFDeck cannot monitor SONY devices, so it does not contact this one.');
  });

  it('names the Sennheiser models that only talk to Sennheiser software', () => {
    expect(isUnsupportedDevice('Sennheiser', 'EM 3732-II')).toBe(true);
    expect(isUnsupportedDevice('Sennheiser', 'EM3731')).toBe(true);
    expect(unsupportedReason('Sennheiser', 'EM 3732')).toMatch(/EM 3731\/3732/);
  });

  it('leaves everything RFDeck supports, and anything unknown, to be contacted', () => {
    expect(isUnsupportedDevice('Sennheiser', 'EW-DX EM 2')).toBe(false);
    expect(isUnsupportedDevice('Sennheiser', 'EM 2050')).toBe(false);
    expect(isUnsupportedDevice('Shure', 'AD4D')).toBe(false);
    expect(isUnsupportedDevice('Other', 'EM 3732')).toBe(false);
    expect(isUnsupportedDevice(undefined)).toBe(false);
    expect(isUnsupportedDevice('')).toBe(false);
  });
});
