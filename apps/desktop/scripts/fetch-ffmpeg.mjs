// Fetch the ffmpeg binary the desktop build captures audio with.
//
// ffmpeg-static downloads its ~80 MB binary in a postinstall step. pnpm skips
// postinstall unless the package is named in onlyBuiltDependencies, and naming
// it there would run the download during every `pnpm install` — including the
// one the Ubuntu server installer runs, on a machine that captures through
// ALSA and has no use for ffmpeg at all. A GitHub outage would then fail a
// server install over a binary it does not need.
//
// So the download is triggered here instead, from the desktop build only.

import { existsSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, '..', 'node_modules', 'ffmpeg-static');
const exe = path.join(pkgDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

if (!existsSync(pkgDir)) {
  console.error(
    'ffmpeg-static is not installed. Run "pnpm install" from the repository root.'
  );
  process.exit(1);
}

// A previous run that was interrupted mid-download leaves a short file behind,
// which would package cleanly and then fail to execute in a venue.
const MIN_PLAUSIBLE_BYTES = 10 * 1024 * 1024;

if (existsSync(exe) && statSync(exe).size >= MIN_PLAUSIBLE_BYTES) {
  console.log(`ffmpeg already present (${exe})`);
  process.exit(0);
}

console.log('Downloading ffmpeg for the desktop build...');
const result = spawnSync(process.execPath, [path.join(pkgDir, 'install.js')], {
  stdio: 'inherit',
  cwd: pkgDir,
});

if (result.status !== 0) {
  console.error('Could not download ffmpeg. The desktop build has no audio capture without it.');
  process.exit(result.status ?? 1);
}
