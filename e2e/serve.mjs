// Boot a real RFDeck for the end-to-end tests.
//
// The whole point of these tests is to exercise what unit tests cannot: the
// contract between the browser, the HTTP API, the socket and the database. So
// this runs the actual built server against a throwaway SQLite file and lets
// it serve the actual built UI — the same path a deployed install takes.
//
// Nothing here is mocked. A client sending a field the server does not accept,
// or a request the PIN gate rejects, fails the test rather than passing it.

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'apps', 'server');
const entry = path.join(serverDir, 'dist', 'server.js');
const webIndex = path.join(root, 'apps', 'web', 'dist', 'index.html');

const PORT = process.env.E2E_PORT ?? '4180';

function die(message) {
  console.error(`\n[e2e] ${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(entry)) {
  die('The server is not built. Run: pnpm --filter @rfdeck/server build');
}
if (!fs.existsSync(webIndex)) {
  die('The web UI is not built. Run: pnpm --filter @rfdeck/web build');
}

// A fresh database per run, so a test can never pass because of a row an
// earlier run left behind.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfdeck-e2e-'));
const dbPath = path.join(dataDir, 'e2e.db').replace(/\\/g, '/');
const DATABASE_URL = `file:${dbPath}`;

const env = {
  ...process.env,
  DATABASE_URL,
  PORT,
  HOST: '127.0.0.1',
  // No certificate: the tests speak plain HTTP.
  TLS_KEY: '',
  TLS_CERT: '',
  HTTP_REDIRECT_PORT: '0',
  LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
  // Scanning the subnet for receivers would make every run slow, noisy and
  // dependent on whatever else is on the tester's network.
  RFDECK_DISABLE_DISCOVERY: '1',
};

const push = spawnSync(
  'pnpm',
  ['--filter', '@rfdeck/server', 'exec', 'prisma', 'db', 'push', '--skip-generate'],
  { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' },
);
if (push.status !== 0) die('Could not create the test database schema.');

const server = spawn(process.execPath, [entry], {
  cwd: serverDir,
  env,
  stdio: 'inherit',
});

const cleanup = () => {
  if (!server.killed) server.kill('SIGTERM');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

server.on('exit', code => {
  if (code !== 0 && code !== null) die(`The server exited with code ${code}.`);
});
