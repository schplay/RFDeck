import { FastifyInstance } from 'fastify';
import healthRoutes from './health';
import { inventoryRoutes } from './inventory';
import { settingsRoutes } from './settings';

export default async function routes(fastify: FastifyInstance) {
  fastify.register(healthRoutes, { prefix: '/health' });
  fastify.register(inventoryRoutes);
  fastify.register(settingsRoutes);
}


