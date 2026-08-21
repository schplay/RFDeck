// Stage the generated Prisma client so it can be packaged.
//
// `@prisma/client` is a normal dependency and electron-builder picks it up, but
// the *generated* client — `.prisma/client`, including the native query engine —
// is build output, not a declared dependency, so the dependency walk never sees
// it. Under pnpm it also lives in the content-addressed store rather than in the
// package's own node_modules, so there is no stable relative path to it.
//
// Without this the packaged app starts, serves the UI, and then fails on every
// database call — which looks like a server bug rather than a packaging one.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, rmSync, mkdirSync, cpSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = join(desktopRoot, '..', 'server');

// Resolve through Node so the pinned version in the store path never matters.
const clientPkg = require.resolve('@prisma/client/package.json', { paths: [serverRoot] });
const source = join(dirname(dirname(dirname(clientPkg))), '.prisma', 'client');

if (!existsSync(source)) {
  console.error(
    `[stage-prisma-client] generated client not found at ${source}\n` +
    `  Run: pnpm --filter @rfdeck/server prisma:generate`
  );
  process.exit(1);
}

const dest = join(desktopRoot, 'resources', 'prisma-client');
if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

cpSync(source, dest, {
  recursive: true,
  // Skip the .tmp artefacts prisma generate leaves behind when a running app
  // holds the engine DLL — they are multi-megabyte and useless.
  filter: (src) => !/\.tmp\d+$/.test(src),
});

const engine = readdirSync(dest).find((f) => f.endsWith('.node'));
if (!engine) {
  console.error('[stage-prisma-client] no query engine binary in the staged client');
  process.exit(1);
}

console.log(`[stage-prisma-client] staged ${engine} → resources/prisma-client`);
