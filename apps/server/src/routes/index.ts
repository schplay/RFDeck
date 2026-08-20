import { FastifyInstance } from 'fastify';
import healthRoutes from './health';
import { inventoryRoutes } from './inventory';
import { settingsRoutes } from './settings';
import { systemRoutes } from './system';

export default async function routes(fastify: FastifyInstance) {
  fastify.register(healthRoutes, { prefix: '/health' });
  fastify.register(inventoryRoutes);
  fastify.register(settingsRoutes);
  fastify.register(systemRoutes);
}


