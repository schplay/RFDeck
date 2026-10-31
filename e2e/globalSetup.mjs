// Start RFDeck for the run, and stop it when the run ends.
//
// Not Playwright's `webServer`: on Windows that ends the server with a forced
// kill of the process tree, which skips every exit handler, so each run's
// database folder was left in the temp folder. Here the run owns the server,
// and the teardown Playwright returns to runs whether the tests passed or
// failed: it stops the server, waits for it to let go of the folder, removes
// the folder, and fails the run if any of it is left.

import fs from 'fs';
import https from 'https';
import { PORT, startServer } from './serve.mjs';

/** Wait for /health over the server's own certificate. */
async function waitForHealth(run, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.server.exitCode !== null) throw new Error(`The server exited with code ${run.server.exitCode}.`);
    const ok = await new Promise(resolve => {
      const req = https.get(
        { host: '127.0.0.1', port: PORT, path: '/health', rejectUnauthorized: false, timeout: 2000 },
        res => { res.resume(); resolve(res.statusCode === 200); },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`The server did not answer /health within ${timeoutMs / 1000} s.`);
}

export default async function globalSetup() {
  const run = startServer();
  try {
    await waitForHealth(run);
  } catch (err) {
    await run.stop();
    throw err;
  }

  return async function globalTeardown() {
    await run.stop();
    if (fs.existsSync(run.dataDir)) throw new Error(`[e2e] ${run.dataDir} was left behind.`);
  };
}
