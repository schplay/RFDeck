import fs from 'fs';
import { log } from './logger';

// TLS for the headless server.
//
// This is not primarily about securing traffic on a closed show network — it is
// about unlocking browser features that only exist in a *secure context*. Audio
// monitoring needs `navigator.mediaDevices`, which browsers withhold entirely
// from pages served over plain HTTP to a network address. Without HTTPS, audio
// monitoring can never work for anyone but someone sitting at the server.
//
// A self-signed certificate is enough: browsers grant secure-context status once
// the user accepts it. See scripts/install-ubuntu.sh, which generates one
// covering every address the machine answers on.

export interface TlsConfig {
  key: Buffer;
  cert: Buffer;
}

// Reads TLS_KEY / TLS_CERT if both are configured and readable.
// Returns null to mean "serve plain HTTP", which stays a valid deployment.
export function loadTlsConfig(): TlsConfig | null {
  const keyPath = process.env.TLS_KEY?.trim();
  const certPath = process.env.TLS_CERT?.trim();

  if (!keyPath && !certPath) return null;

  // Half-configured is a mistake worth naming rather than silently ignoring.
  if (!keyPath || !certPath) {
    log.error(
      'TLS is half-configured: both TLS_KEY and TLS_CERT are required. ' +
      'Continuing over plain HTTP.'
    );
    return null;
  }

  try {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch (err: any) {
    // Falling back to HTTP here would quietly downgrade a deployment that asked
    // for TLS, and nobody would find out until audio monitoring failed.
    log.error(
      `Could not read the TLS certificate or key (${err?.message}). ` +
      'Refusing to start rather than silently downgrading to HTTP.'
    );
    process.exit(1);
  }
}
