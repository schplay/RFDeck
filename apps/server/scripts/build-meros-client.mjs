// Build the meros-client helper RFDeck talks to Meros Cloud through, and put it
// where the server looks for it: apps/server/bin/meros-client(.exe).
//
// The helper is Rust, shared by every Meros product, and built from source at
// the commit pinned in package.json ("merosClient"). Building needs a Rust
// toolchain (cargo). Set MEROS_CLIENT_SRC to a local checkout to build that
// instead of the pinned commit.
//
// Skipped when the binary is already there and was built from the pinned
// commit, which bin/meros-client.rev records.

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
const { repository, rev } = pkg.merosClient;
const exe = process.platform === 'win32' ? 'meros-client.exe' : 'meros-client';
const binDir = path.join(serverDir, 'bin');
const target = path.join(binDir, exe);
const stamp = path.join(binDir, 'meros-client.rev');
const source = process.env.MEROS_CLIENT_SRC?.trim();
const wanted = source ? `path:${path.resolve(source)}` : rev;

if (!source && fs.existsSync(target) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === wanted) {
  console.log(`meros-client ${rev.slice(0, 7)} already built (${target})`);
  process.exit(0);
}

const root = path.join(serverDir, '.meros-client-build');
const args = ['install', '--locked', '--features', 'cli', '--bin', 'meros-client', '--root', root, '--force'];
if (source) args.push('--path', path.resolve(source));
else args.push('--git', repository, '--rev', rev);

console.log(`Building meros-client from ${source ?? `${repository} @ ${rev.slice(0, 7)}`}...`);
const result = spawnSync('cargo', args, { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status !== 0) {
  console.error('Could not build meros-client. RFDeck needs it for Meros Cloud. Is a Rust toolchain (cargo) installed?');
  process.exit(result.status ?? 1);
}

fs.mkdirSync(binDir, { recursive: true });
fs.copyFileSync(path.join(root, 'bin', exe), target);
if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
fs.writeFileSync(stamp, `${wanted}\n`);
fs.rmSync(root, { recursive: true, force: true });
console.log(`meros-client ready at ${target}`);
