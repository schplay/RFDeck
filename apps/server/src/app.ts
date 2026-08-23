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
const OPEN_PATHS = new Set(['/api/auth/status', '/api/auth/login', '/health']);

export async function buildApp(): Promise<FastifyInstance> {
  // Serve over HTTPS when a certificate is configured. Browsers only expose
  // audio capture to secure contexts, so this is what makes audio monitoring
  // possible for clients other than the machine running the server.
  const tls = loadTlsConfig();

  // Fastify logs every request by default. Telemetry-driven UIs poll steadily,
  // so on a long-running service that is pure journal noise — enable it only
  // when someone has asked for debug output.
  const app = Fastify({
    logger: log.isDebug ? true : false,
    ...(tls ? { https: { key: tls.key, cert: tls.cert } } : {}),
  });

  // Let the rest of the process know which scheme is in play.
  app.decorate('isSecure', !!tls);

  await app.register(cors, { origin: true });
  await app.register(prismaPlugin);
  await app.register(socketPlugin);

  // Global PIN gate. No-op on the default open configuration.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (OPEN_PATHS.has(path)) return;

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
