import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import prismaPlugin from './plugins/prisma';
import socketPlugin from './plugins/socket';
import routes from './routes';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(prismaPlugin);
  await app.register(socketPlugin);
  
  await app.register(routes, { prefix: '/api' });

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date() };
  });

  return app;
}
