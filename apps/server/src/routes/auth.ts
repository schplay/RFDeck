import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import {
  getAuthState, isLoopback, issueToken, isTokenValid,
  makePinHash, verifyPin, revokeAllTokens,
  pinRetryAfterMs, notePinFailure, clearPinFailures,
} from '../auth/pinAuth';

// Who is allowed to change access settings?
//
// The rule has to work on a headless server, where nobody can open a browser on
// the host — so "loopback only" would make the PIN unreachable in exactly the
// deployment it exists for.
//
//   • Loopback — the desktop app, or a shell on the host. Always trusted.
//   • No PIN set yet — anyone can set the first one. The server is already open
//     to the whole network in this state, so this grants nothing that was not
//     already available; it is what makes remote bootstrap possible at all.
//   • PIN set — only a client that has authenticated with it. Knowing the
//     current PIN is the credential for changing it.
//
// Shell access to the server remains the recovery path: see `rfdeck` CLI.
async function mayConfigureAccess(request: any): Promise<boolean> {
  if (isLoopback(request.ip)) return true;

  const settings = await prisma.settings.findFirst();
  const pinConfigured = !!settings?.authPinEnabled && !!settings?.authPinHash;
  if (!pinConfigured) return true;

  return isTokenValid(request.headers['x-rfdeck-token'] as string | undefined);
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // What does this client need to do before it can talk to us?
  // Called before anything else on app load, so it must never require auth.
  fastify.get('/auth/status', async (request) => {
    const { enabled, reauthHours } = await getAuthState();
    const local = isLoopback(request.ip);
    const token = (request.headers['x-rfdeck-token'] as string | undefined);
    return {
      pinEnabled:    enabled,
      isLocal:       local,
      reauthHours,
      // The one field the client actually branches on.
      authenticated: !enabled || local || isTokenValid(token),
      // Whether THIS client may change access settings. A headless server has
      // no browser on the host, so this cannot simply mean "is local".
      canConfigure:  await mayConfigureAccess(request),
      // This install's certificate fingerprint, for the operator to compare with
      // what a client shows when pairing. Served here because the UI already calls
      // this on load, and published unauthenticated because anyone who reached it
      // has already been handed the certificate it describes.
      //
      // Self-reported, so it is for display and never for a client to trust: a man
      // in the middle would serve its own value from here too. What makes it worth
      // anything is a person comparing it with what the other end shows.
      tlsFingerprint: (fastify as any).tlsFingerprint as string,
    };
  });

  /**
   * The PIN login, for browsers.
   *
   * The PIN is how RFDeck gates its *UI* without having user accounts: an operator
   * sets one, and any other device opening the interface in a browser has to enter
   * it. It was never meant for server-to-server callers, and a machine client
   * should be issued its own credential instead - a shared four-digit secret cannot
   * be revoked for one console, cannot be scoped to read-only, and is far too small
   * to be a machine credential.
   *
   * A certificate-bound proof form of this endpoint existed briefly, for exactly
   * that server-to-server case. It went away with its premise: browsers are the
   * only PIN users, a browser cannot compute scrypt without a dependency, and
   * unreachable code on an authentication path is worse than none.
   */
  fastify.post('/auth/login', async (request, reply) => {
    const { pin } = request.body as { pin?: string };
    const settings = await prisma.settings.findFirst();

    if (!settings?.authPinEnabled) {
      // PIN disabled - nothing to authenticate against.
      return { authenticated: true, token: null };
    }

    // Throttled because a four-digit PIN is 10,000 candidates: seconds of
    // unthrottled requests rather than a cryptographic attack.
    const waitMs = pinRetryAfterMs(request.ip);
    if (waitMs > 0) {
      return reply.code(429)
        .header('Retry-After', String(Math.ceil(waitMs / 1000)))
        .send({ error: 'Too many incorrect PINs. Try again shortly.' });
    }

    if (!settings.authPinHash || !pin || !verifyPin(pin, settings.authPinHash)) {
      notePinFailure(request.ip);
      return reply.code(401).send({ error: 'Incorrect PIN' });
    }
    clearPinFailures(request.ip);

    return {
      authenticated: true,
      token: issueToken(settings.authReauthHours ?? 0),
    };
  });

  // Configure the PIN. See mayConfigureAccess for who is permitted.
  fastify.put('/auth/config', async (request, reply) => {
    if (!(await mayConfigureAccess(request))) {
      return reply.code(403).send({
        error: 'Enter the current PIN before changing access settings.',
      });
    }

    const { pinEnabled, pin, reauthHours } = request.body as {
      pinEnabled?: boolean; pin?: string; reauthHours?: number;
    };

    let settings = await prisma.settings.findFirst();
    if (!settings) settings = await prisma.settings.create({ data: {} });

    if (pinEnabled && !pin && !settings.authPinHash) {
      return reply.code(400).send({ error: 'Set a PIN before enabling remote access control' });
    }

    const updated = await prisma.settings.update({
      where: { id: settings.id },
      data: {
        authPinEnabled:  typeof pinEnabled  === 'boolean' ? pinEnabled  : undefined,
        authPinHash:     pin ? makePinHash(pin) : undefined,
        authReauthHours: typeof reauthHours === 'number' ? Math.max(0, reauthHours) : undefined,
      },
    });

    // Changing the PIN or turning the gate on invalidates every existing
    // session — otherwise a rotated PIN wouldn't actually lock anyone out.
    if (pin || pinEnabled === true) revokeAllTokens();

    return {
      pinEnabled:  updated.authPinEnabled,
      reauthHours: updated.authReauthHours,
      pinIsSet:    !!updated.authPinHash,
    };
  });

  // Force every remote client to re-enter the PIN (e.g. after a crew change).
  fastify.post('/auth/revoke-all', async (request, reply) => {
    if (!(await mayConfigureAccess(request))) {
      return reply.code(403).send({ error: 'Enter the current PIN first.' });
    }
    revokeAllTokens();
    return { success: true };
  });
};
