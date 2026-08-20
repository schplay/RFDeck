// Compile preload.ts to CommonJS and give it a .cjs extension.
//
// Electron loads preload scripts as CommonJS, but apps/desktop is
// "type": "module" — which makes Node treat any .js file here as ESM. Without
// the rename the preload throws "Cannot use import statement outside a module"
// at startup and contextBridge never reaches the renderer.
import { execFileSync } from 'node:child_process';
import { renameSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Resolve the compiler through Node rather than shelling out to npx — pnpm's
// nested store means npx is not reliably on PATH from a workspace package.
const tsc = join(dirname(require.resolve('typescript')), 'tsc.js');

execFileSync(process.execPath, [tsc, '-p', 'tsconfig.preload.json'], {
  cwd: root,
  stdio: 'inherit',
});

const emitted = join(root, 'dist', 'preload.js');
const target  = join(root, 'dist', 'preload.cjs');

if (!existsSync(emitted)) {
  console.error('[build-preload] expected dist/preload.js — did tsc emit elsewhere?');
  process.exit(1);
}

if (existsSync(target)) rmSync(target);
renameSync(emitted, target);
console.log('[build-preload] dist/preload.cjs written');
