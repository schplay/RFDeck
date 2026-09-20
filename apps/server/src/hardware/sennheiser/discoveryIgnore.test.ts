import { describe, it, expect } from 'vitest';
import { parseIgnoreList, isIgnored } from './discoveryIgnore';

// What an operator excludes has to be excluded exactly. Too wide and a
// receiver silently stops being found, with a scan that reports an empty
// network and no clue why; too narrow and RFDeck carries on presenting
// unauthenticated requests to somebody else's appliance.

describe('parseIgnoreList', () => {
  it('takes single addresses, CIDRs and dashed ranges together', () => {
    const rules = parseIgnoreList('10.0.1.5, 10.0.2.0/24\n10.0.3.20-10.0.3.40');
    expect(rules.map(r => r.text)).toEqual(['10.0.1.5', '10.0.2.0/24', '10.0.3.20-10.0.3.40']);
  });

  it('matches only what it should', () => {
    const rules = parseIgnoreList('10.0.1.5 10.0.2.0/24 10.0.3.20-10.0.3.40');
    expect(isIgnored('10.0.1.5', rules)).toBe(true);
    expect(isIgnored('10.0.1.6', rules)).toBe(false);

    expect(isIgnored('10.0.2.0', rules)).toBe(true);
    expect(isIgnored('10.0.2.255', rules)).toBe(true);
    expect(isIgnored('10.0.3.0', rules)).toBe(false);

    expect(isIgnored('10.0.3.19', rules)).toBe(false);
    expect(isIgnored('10.0.3.20', rules)).toBe(true);
    expect(isIgnored('10.0.3.40', rules)).toBe(true);
    expect(isIgnored('10.0.3.41', rules)).toBe(false);
  });

  it('snaps a CIDR to its network boundary', () => {
    // "10.0.2.37/24" means the /24 that contains it, not 37 addresses on.
    const rules = parseIgnoreList('10.0.2.37/24');
    expect(isIgnored('10.0.2.1', rules)).toBe(true);
    expect(isIgnored('10.0.1.1', rules)).toBe(false);
  });

  it('accepts a range written backwards', () => {
    const rules = parseIgnoreList('10.0.3.40-10.0.3.20');
    expect(isIgnored('10.0.3.30', rules)).toBe(true);
  });

  it('refuses to let a typo switch discovery off', () => {
    // A /0 covers every address. Reading that as "exclude everything" would
    // make a mistyped subnet look exactly like a broken network.
    expect(parseIgnoreList('10.0.0.0/0')).toEqual([]);
  });

  it('drops what it cannot parse instead of guessing', () => {
    expect(parseIgnoreList('not-an-ip, 10.0.1.999, 10.0.1.1/33')).toEqual([]);
    expect(parseIgnoreList('')).toEqual([]);
    expect(parseIgnoreList(null)).toEqual([]);
  });

  it('never matches when the list is empty', () => {
    expect(isIgnored('10.0.1.1', [])).toBe(false);
  });
});
