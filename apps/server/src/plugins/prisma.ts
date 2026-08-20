import fp from 'fastify-plugin';
import { prisma } from '../db';

export default fp(async (fastify) => {
  await prisma.$connect();

  fastify.decorate('prisma', prisma);

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    prisma: typeof prisma;
  }
}
