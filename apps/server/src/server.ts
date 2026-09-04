import http from 'http';
import { buildApp } from './app';
import { log } from './logger';
import { backfillPerformers } from './performers/roster';
import { announceBackend } from './audio/backends';

// A redirect listener on plain HTTP, so someone who types the bare address
// still lands on the app instead of a connection error. Purely a convenience:
// the real server is the HTTPS one.
function startHttpRedirect(httpPort: number, httpsPort: number): void {
  const server = http.createServer((req, res) => {
    // Preserve the host the client used — it may be an IP, a hostname, or an
    // mDNS name, and redirecting to the wrong one breaks the certificate match.
    const host = (req.headers.host ?? '').split(':')[0];
    if (!host) {
      res.writeHead(400);
      return res.end('Missing Host header');
    }
    const suffix = httpsPort === 443 ? '' : `:${httpsPort}`;
    res.writeHead(301, { Location: `https://${host}${suffix}${req.url ?? '/'}` });
    res.end();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    // Not fatal — HTTPS is already serving. Most likely something else owns
    // port 80, which is worth saying but not worth refusing to run over.
    log.warn(
      `HTTP redirect listener could not start on port ${httpPort} (${err.code}). ` +
      'Clients will need to type https:// explicitly.'
    );
  });

  server.listen(httpPort, process.env.HOST || '0.0.0.0');
}

async function start() {
  const app = await buildApp();
  const secure = (app as any).isSecure as boolean;

  // Cast entries created before the performer roster existed are linked to it
  // by name. Idempotent, and must not stop the server from coming up.
  try {
    await backfillPerformers();
  } catch (err) {
    log.warn('Performer roster backfill failed; existing cast entries stay unlinked:', err);
  }

  // Default to the conventional port for whichever scheme is in use, so the
  // address is just the server's IP with nothing to remember.
  const port = parseInt(process.env.PORT || (secure ? '443' : '3000'), 10);
  // 0.0.0.0 so clients elsewhere on the venue network can reach it — RFDeck is
  // a multi-client service in every deployment shape.
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen({ port, host });
    log.info(`RFDeck server listening on ${secure ? 'https' : 'http'}://${host}:${port}`);
    // Say which capture path this machine got, at startup rather than on the
    // first attempt to listen to a mic. The desktop build shipped with none at
    // all and gave no sign of it until someone tried to use audio during a
    // show.
    announceBackend();
  } catch (err) {
    log.error('Failed to start server:', err);
    process.exit(1);
  }

  if (secure) {
    const redirectPort = parseInt(process.env.HTTP_REDIRECT_PORT || '80', 10);
    // Guard against being told to redirect a port onto itself.
    if (redirectPort > 0 && redirectPort !== port) {
      startHttpRedirect(redirectPort, port);
      log.info(`Redirecting plain HTTP on port ${redirectPort} to HTTPS`);
    }
  }
}

// Under systemd a clean SIGTERM shutdown lets the socket close and devices
// disconnect tidily, instead of the unit being killed after a timeout.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`Received ${signal}, shutting down`);
    process.exit(0);
  });
}

start();
