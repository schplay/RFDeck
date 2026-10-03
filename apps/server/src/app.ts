import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import prismaPlugin from './plugins/prisma';
import socketPlugin from './plugins/socket';
import frontendPlugin from './plugins/frontend';
import routes from './routes';
import { isRequestAuthorized } from './auth/pinAuth';
import { log } from './logger';
import { loadTlsConfig } from './tls';

// Endpoints reachable before authentication. Everything else is gated when the
// admin has enabled a PIN; /auth/status is how a client discovers it needs one.
export const OPEN_PATHS = new Set([
  '/api/auth/status', '/api/auth/login', '/health',
  // The Micboard display. A wall-mounted screen cannot type a PIN, and the PIN
  // exists to prevent unauthorised *changes* rather than to hide telemetry —
  // so reading is allowed without one. Scoped to what a display needs: this
  // endpoint carries only who is on each channel, never inventory, event
  // history, or anything that could be written.
  '/api/micboard',
]);

// Further reads the Micboard needs, matched by METHOD as well as path.
//
// The set above cannot express that: it matches a path whatever the verb, and
// /api/live answers POST and DELETE as well as GET. Listing it there would
// have let anyone on the network go live — or stand the whole rig down —
// without the PIN. Reading is exempt; changing never is.
function isOpenRead(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  // Whether anything is running, and whose cast is on the wall.
  if (path === '/api/live') return true;
  // Headshots. A prefix rather than a fixed path because the id is in the URL.
  return /^\/api\/performers\/[\w-]+\/photo$/.test(path);
}

/**
 * Does this request reach the application without a PIN?
 *
 * Pulled out of the gate hook so it can be tested. Membership of `OPEN_PATHS` is
 * not the same claim as the gate honouring it, and the difference is not
 * academic: a route was once added and left out of that set, which made the
 * feature needing it unreachable on exactly the installs that enable a PIN.
 *
 * Takes the method as well as the path, because some exemptions are reads only.
 */
export function needsNoPin(method: string, path: string): boolean {
  return OPEN_PATHS.has(path) || isOpenRead(method, path);
}

export async function buildApp(): Promise<FastifyInstance> {
  // Always HTTPS. A certificate is generated and kept when none is configured,
  // so this is no longer a deployment choice - see tls.ts for why that changed.
  // Browsers also expose audio capture only to secure contexts, which is what
  // makes audio monitoring work for clients other than the one at the server.
  const tls = await loadTlsConfig();

  // Fastify logs every request by default. Telemetry-driven UIs poll steadily,
  // so on a long-running service that is pure journal noise — enable it only
  // when someone has asked for debug output.
  const app = Fastify({
    logger: log.isDebug ? true : false,
    https: { key: tls.key, cert: tls.cert },
  });

  // Always true now, and kept so every caller does not have to change. HTTPS is
  // a property of RFDeck rather than of whether somebody configured a
  // certificate: loadTlsConfig generates one when none is.
  app.decorate('isSecure', true);
  // The pin. Manifold compares this with what its TLS session presented, and the
  // operator confirms the short form of it at pairing.
  app.decorate('tlsFingerprint', tls.spki);

  await app.register(cors, { origin: true });
  await app.register(prismaPlugin);
  await app.register(socketPlugin);

  // Global PIN gate. No-op on the default open configuration.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (needsNoPin(request.method, path)) return;

    // The header is how the app authenticates. A plain navigation — opening
    // the printable show report in a new tab — cannot set headers, so a GET
    // may carry the same token as a query parameter instead. GET only: a
    // token in a URL can end up in history, so it is not accepted for
    // anything that changes state.
    const query = request.query as Record<string, unknown> | undefined;
    const queryToken = request.method === 'GET' && typeof query?.token === 'string'
      ? query.token
      : undefined;
    const token = (request.headers['x-rfdeck-token'] as string | undefined) ?? queryToken;
    if (await isRequestAuthorized(request.ip, token)) return;

    return reply.code(401).send({ error: 'PIN required', code: 'PIN_REQUIRED' });
  });

  await app.register(routes, { prefix: '/api' });

  // Registered after the API so its catch-all cannot shadow a real route.
  await app.register(frontendPlugin);

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date() };
  });

  return app;
}
