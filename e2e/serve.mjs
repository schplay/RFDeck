// Boot a real RFDeck for the end-to-end tests.
//
// The whole point of these tests is to exercise what unit tests cannot: the
// contract between the browser, the HTTP API, the socket and the database. So
// this runs the actual built server against a throwaway SQLite file and lets
// it serve the actual built UI — the same path a deployed install takes.
//
// Nothing here is mocked. A client sending a field the server does not accept,
// or a request the PIN gate rejects, fails the test rather than passing it.
//
// Playwright's global setup starts it (`e2e/globalSetup.mjs`) and stops it
// when the run ends, passed or failed, removing the run's folder. Run directly
// (`node e2e/serve.mjs`), it serves until stopped with Ctrl+C.

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'apps', 'server');
const entry = path.join(serverDir, 'dist', 'server.js');
const webIndex = path.join(root, 'apps', 'web', 'dist', 'index.html');

export const PORT = process.env.E2E_PORT ?? '4180';

// Each run's folder is named after the process that made it, so a later run
// can tell which leftovers are dead: a run that was itself killed (Ctrl+C
// twice, a closed terminal) never reaches its own cleanup.
export const RUN_PREFIX = 'rfdeck-e2e-';

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }   // exists, owned by someone else
}

/** Remove the folders of runs whose process is gone. */
function sweepDeadRuns() {
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith(RUN_PREFIX)) continue;
    const pid = Number(name.slice(RUN_PREFIX.length).split('-')[0]);
    // Folders from before this naming have no pid; they are leftovers too.
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) continue;
    try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); } catch { /* still locked */ }
  }
}

/**
 * Remove a folder the server has just let go of. Windows keeps the database
 * file locked for a moment after the process exits, so it is retried.
 */
async function removeWhenFree(dir) {
  for (let i = 0; i < 40; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return;
    } catch { /* still locked */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`[e2e] Could not remove ${dir}; something still holds it.`);
}

/**
 * Start the server on a fresh database. Resolves once it has been spawned;
 * the caller waits for /health. `stop()` ends it and removes its folder.
 */
export function startServer() {
  if (!fs.existsSync(entry)) throw new Error('The server is not built. Run: pnpm --filter @rfdeck/server build');
  if (!fs.existsSync(webIndex)) throw new Error('The web UI is not built. Run: pnpm --filter @rfdeck/web build');

  sweepDeadRuns();

  // A fresh database per run, so a test can never pass because of a row an
  // earlier run left behind.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${RUN_PREFIX}${process.pid}-`));
  const dbPath = path.join(dataDir, 'e2e.db').replace(/\\/g, '/');
  const DATABASE_URL = `file:${dbPath}`;

  const env = {
    ...process.env,
    DATABASE_URL,
    PORT,
    HOST: '127.0.0.1',
    // No configured certificate: the server generates its own beside the test
    // database, as a fresh install does, and the tests speak HTTPS to it.
    TLS_KEY: '',
    TLS_CERT: '',
    HTTP_REDIRECT_PORT: '0',
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
    // Scanning the subnet for receivers would make every run slow, noisy and
    // dependent on whatever else is on the tester's network.
    RFDECK_DISABLE_DISCOVERY: '1',
    // No cloud. Empty rather than deleted: the server fills unset variables from
    // a developer's .env.local, but never overwrites one that is present, so this
    // also keeps that file from pointing a test run at a real cloud service.
    MEROS_BASE_URL: '',
    MEROS_CLIENT_ID: '',
  };

  const push = spawnSync(
    'pnpm',
    ['--filter', '@rfdeck/server', 'exec', 'prisma', 'db', 'push', '--skip-generate'],
    { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (push.status !== 0) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw new Error('Could not create the test database schema.');
  }

  // The server is this process's own child, so stopping it is one kill and
  // its exit is ours to wait for: nothing is left running to hold the folder.
  const server = spawn(process.execPath, [entry], { cwd: serverDir, env, stdio: 'inherit' });
  const exited = new Promise(resolve => server.once('exit', resolve));

  return {
    dataDir,
    server,
    exited,
    async stop() {
      if (server.exitCode === null && server.signalCode === null) server.kill();
      await exited;
      await removeWhenFree(dataDir);
    },
  };
}

// Run directly: serve until stopped.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = startServer();
  const stop = () => void run.stop().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  run.server.on('exit', code => {
    if (code !== 0 && code !== null) {
      console.error(`\n[e2e] The server exited with code ${code}.\n`);
      void run.stop().finally(() => process.exit(1));
    }
  });
}
