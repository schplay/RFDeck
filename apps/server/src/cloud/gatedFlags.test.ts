import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { FEATURES, GATED_BY_RFDECK } from './features';

// Every flag RFDeck says it gates must actually be checked somewhere.
//
// The show-file flags were listed here for months while no route looked at
// them, so show-file sync worked for accounts that did not include it. A list
// that nothing enforces is worse than no list: it reads as a guarantee.

const SRC = join(__dirname, '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'features.ts') out.push(full);
  }
  return out;
}

describe('flags RFDeck gates', () => {
  const code = sources(SRC).map(f => readFileSync(f, 'utf8')).join('\n');
  const keyOf = (flag: string) => Object.entries(FEATURES).find(([, v]) => v === flag)![0];

  for (const flag of GATED_BY_RFDECK) {
    it(`checks ${flag} somewhere`, () => {
      expect(code).toMatch(new RegExp(String.raw`(denied|entitled)\([^)]*FEATURES\.${keyOf(flag)}`));
    });
  }
});
