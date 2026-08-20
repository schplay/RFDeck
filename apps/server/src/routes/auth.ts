import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import {
  getAuthState, isLoopback, issueToken, isTokenValid,
  makePinHash, verifyPin, revokeAllTokens,
} from '../auth/pinAuth';

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
    };
  });

  fastify.post('/auth/login', async (request, reply) => {
    const { pin } = request.body as { pin?: string };
    const settings = await prisma.settings.findFirst();

    if (!settings?.authPinEnabled) {
      // PIN disabled — nothing to authenticate against.
      return { authenticated: true, token: null };
    }
    if (!settings.authPinHash || !pin || !verifyPin(pin, settings.authPinHash)) {
      return reply.code(401).send({ error: 'Incorrect PIN' });
    }

    return {
      authenticated: true,
      token: issueToken(settings.authReauthHours ?? 0),
    };
  });

  // Configure the PIN. Deliberately restricted to loopback: with no user
  // accounts there is no other way to distinguish an admin from any other
  // client on the network, and letting a remote client change the PIN would
  // make the whole control worthless.
  fastify.put('/auth/config', async (request, reply) => {
    if (!isLoopback(request.ip)) {
      return reply.code(403).send({
        error: 'Access settings can only be changed from the machine running RFDeck',
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
    if (!isLoopback(request.ip)) {
      return reply.code(403).send({ error: 'Only available on the host machine' });
    }
    revokeAllTokens();
    return { success: true };
  });
};
