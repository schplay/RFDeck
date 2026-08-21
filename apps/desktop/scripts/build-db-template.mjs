// Produce an empty database with the schema applied, to ship with the app.
//
// A packaged install cannot run `prisma db push` — the Prisma CLI is a dev
// dependency and the install directory is read-only. So the app carries a
// pre-migrated empty database and copies it into the user data directory on
// first run.
//
// Built fresh each time from the current schema, so the template can never
// drift from the models the server expects.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = join(desktopRoot, '..', 'server');
const outDir = join(desktopRoot, 'resources');
const outFile = join(outDir, 'template.db');

mkdirSync(outDir, { recursive: true });
// Always start clean — a stale template would carry old rows into every install.
if (existsSync(outFile)) rmSync(outFile);

const prismaCli = join(
  dirname(require.resolve('prisma/package.json', { paths: [serverRoot] })),
  'build',
  'index.js',
);

execFileSync(
  process.execPath,
  [prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'],
  {
    cwd: serverRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Prisma needs a URL, and Windows backslashes are not valid in one.
      DATABASE_URL: `file:${outFile.replace(/\\/g, '/')}`,
    },
  },
);

if (!existsSync(outFile)) {
  console.error('[build-db-template] prisma db push did not produce a database');
  process.exit(1);
}
console.log(`[build-db-template] ${outFile} written`);
