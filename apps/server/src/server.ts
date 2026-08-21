import { buildApp } from './app';
import { log } from './logger';

async function start() {
  const app = await buildApp();
  const port = parseInt(process.env.PORT || '3000', 10);
  // 0.0.0.0 so clients elsewhere on the venue network can reach it — RFDeck is
  // a multi-client service in every deployment shape.
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen({ port, host });
    log.info(`RFDeck server listening on ${host}:${port}`);
  } catch (err) {
    log.error('Failed to start server:', err);
    process.exit(1);
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
