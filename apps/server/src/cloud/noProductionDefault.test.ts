import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { readCloudConfig } from './config';

// Nothing but a release install may ever reach the production cloud service.
//
// The cloud is off unless MEROS_BASE_URL is set, and only a release install is
// given a production origin, by whoever deploys it. So the guarantee is that no
// code, test, script, E2E run or CI job ever supplies one: development uses
// staging through a gitignored .env.local, and tests use the in-repo fake.

const ROOT = join(__dirname, '..', '..', '..', '..');

// Any origin under the production domain except staging. Built from parts so
// this file does not trip its own check.
const PRODUCTION = new RegExp(
  'https?://(?![a-z0-9-]*staging)[a-z0-9.-]*\\b' + 'meros' + '\\.co(?![a-z0-9-])',
  'i',
);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', '.turbo', 'test-results', 'playwright-report']);
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|sh|ps1|env|service)$|^\.env$|^rfdeck$/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (TEXT.test(name) && full !== __filename) {
      out.push(full);
    }
  }
  return out;
}

describe('no development or test path defaults to the production cloud', () => {
  it('has no built-in origin: unconfigured means off', () => {
    expect(readCloudConfig({})).toBeNull();
    expect(readCloudConfig({ MEROS_CLIENT_ID: 'x' })).toBeNull();
  });

  it('names no production origin in code, tests, scripts, E2E or CI', () => {
    const files = [
      ...walk(join(ROOT, 'apps', 'server', 'src')),
      ...walk(join(ROOT, 'apps', 'web', 'src')),
      ...walk(join(ROOT, 'apps', 'desktop', 'src')),
      ...walk(join(ROOT, 'apps', 'desktop', 'scripts')),
      ...walk(join(ROOT, 'packages')),
      ...walk(join(ROOT, 'e2e')),
      ...walk(join(ROOT, 'scripts')),
      ...walk(join(ROOT, '.github')),
      join(ROOT, 'apps', 'server', '.env'),
      join(ROOT, 'apps', 'desktop', 'electron-builder.yml'),
      join(ROOT, 'playwright.config.ts'),
      join(ROOT, 'package.json'),
      join(ROOT, 'apps', 'server', 'package.json'),
      join(ROOT, 'apps', 'web', 'package.json'),
      join(ROOT, 'apps', 'desktop', 'package.json'),
    ].filter(existsSync);

    expect(files.length).toBeGreaterThan(100);
    const hits = files
      .filter(f => PRODUCTION.test(readFileSync(f, 'utf8')))
      .map(f => relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  it('runs E2E with the cloud off, whatever a developer has in .env.local', () => {
    const serve = readFileSync(join(ROOT, 'e2e', 'serve.mjs'), 'utf8');
    expect(serve).toMatch(/MEROS_BASE_URL:\s*''/);
    expect(serve).toMatch(/MEROS_CLIENT_ID:\s*''/);
  });

  it('keeps a developer\'s .env.local out of the desktop installer', () => {
    const afterPack = readFileSync(join(ROOT, 'apps', 'desktop', 'scripts', 'afterPack.cjs'), 'utf8');
    expect(afterPack).toMatch(/remove\(path\.join\(serverPkg, '\.env\.local'\)/);
  });
});
