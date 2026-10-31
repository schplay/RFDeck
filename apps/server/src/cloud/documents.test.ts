import { describe, it, expect } from 'vitest';
import { contentHash, canonicalJson } from './documents';

// The canonical form RFDeck hashes its own copy of a document with, to tell
// whether it still matches what it last synced. It must agree with Meros and
// the meros-client helper; merosHelper.test.ts checks that against a real
// show file. Pushing, pulling and conflicts are the helper's, and are tested
// there too.

describe('the canonical hash', () => {
  it('sorts object keys recursively, so key order cannot change the hash', () => {
    // The whole point of canonicalising. Meros used to hash its own re-encoding
    // of whatever arrived, which no client could reproduce.
    const a = { b: 1, a: { d: 2, c: [1, 2] } };
    const z = { a: { c: [1, 2], d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(z));
    expect(contentHash(a)).toBe(contentHash(z));
    expect(canonicalJson(a)).toBe('{"a":{"c":[1,2],"d":2},"b":1}');
  });

  it('leaves array order alone, because array order is meaningful', () => {
    expect(contentHash({ xs: [1, 2, 3] })).not.toBe(contentHash({ xs: [3, 2, 1] }));
    expect(canonicalJson({ xs: [{ b: 1, a: 2 }] })).toBe('{"xs":[{"a":2,"b":1}]}');
  });

  it('emits no whitespace, unescaped slashes and unescaped unicode', () => {
    // Matching PHP's JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE.
    expect(canonicalJson({ url: 'https://meros.test/link', who: 'Renée Fleming' }))
      .toBe('{"url":"https://meros.test/link","who":"Renée Fleming"}');
  });

  it('is stable across nesting depth and null', () => {
    const deep = { z: { y: { x: [{ b: null, a: 1 }] } } };
    expect(canonicalJson(deep)).toBe('{"z":{"y":{"x":[{"a":1,"b":null}]}}}');
  });
});
