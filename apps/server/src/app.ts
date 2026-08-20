import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import prismaPlugin from './plugins/prisma';
import socketPlugin from './plugins/socket';
import routes from './routes';
import { isRequestAuthorized } from './auth/pinAuth';

// Endpoints reachable before authentication. Everything else is gated when the
// admin has enabled a PIN; /auth/status is how a client discovers it needs one.
const OPEN_PATHS = new Set(['/api/auth/status', '/api/auth/login', '/health']);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(prismaPlugin);
  await app.register(socketPlugin);

  // Global PIN gate. No-op on the default open configuration.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (OPEN_PATHS.has(path)) return;

    const token = request.headers['x-rfdeck-token'] as string | undefined;
    if (await isRequestAuthorized(request.ip, token)) return;

    return reply.code(401).send({ error: 'PIN required', code: 'PIN_REQUIRED' });
  });

  await app.register(routes, { prefix: '/api' });

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date() };
  });

  return app;
}
