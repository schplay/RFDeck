import { describe, it, expect } from 'vitest';
import { isUnsupportedManufacturer } from './manufacturers';

// Brands the server must never contact, because nothing it starts for them
// could ever connect.

describe('isUnsupportedManufacturer', () => {
  it('names the brands RFDeck cannot talk to, whatever the case or spacing', () => {
    expect(isUnsupportedManufacturer('Wisycom')).toBe(true);
    expect(isUnsupportedManufacturer('lectrosonics')).toBe(true);
    expect(isUnsupportedManufacturer(' SONY ')).toBe(true);
  });

  it('leaves the brands RFDeck supports, and anything unknown, to be contacted', () => {
    expect(isUnsupportedManufacturer('Sennheiser')).toBe(false);
    expect(isUnsupportedManufacturer('Shure')).toBe(false);
    expect(isUnsupportedManufacturer('Other')).toBe(false);
    expect(isUnsupportedManufacturer(undefined)).toBe(false);
    expect(isUnsupportedManufacturer('')).toBe(false);
  });
});
