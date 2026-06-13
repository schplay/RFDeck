import { FastifyInstance } from 'fastify';

export default async function (fastify: FastifyInstance) {
  fastify.get('/', async () => {
    return { status: 'ok', timestamp: new Date() };
  });
}
