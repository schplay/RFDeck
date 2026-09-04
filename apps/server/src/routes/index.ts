import { FastifyInstance } from 'fastify';
import healthRoutes from './health';
import { inventoryRoutes } from './inventory';
import { settingsRoutes } from './settings';
import { systemRoutes } from './system';
import { showRoutes } from './shows';
import { authRoutes } from './auth';
import { eventRoutes } from './events';
import { audioRoutes } from './audio';
import { aes67Routes } from './aes67';
import { performerRoutes } from './performers';
import { showReportRoutes } from './showReport';
import { detectionRoutes } from './detections';
import { micboardRoutes } from './micboard';
import { liveRoutes } from './live';
import { maintenanceRoutes } from './maintenance';

export default async function routes(fastify: FastifyInstance) {
  fastify.register(healthRoutes, { prefix: '/health' });
  fastify.register(authRoutes);
  fastify.register(inventoryRoutes);
  fastify.register(settingsRoutes);
  fastify.register(systemRoutes);
  fastify.register(showRoutes);
  fastify.register(eventRoutes);
  fastify.register(audioRoutes);
  fastify.register(aes67Routes);
  fastify.register(performerRoutes);
  fastify.register(showReportRoutes);
  fastify.register(detectionRoutes);
  fastify.register(micboardRoutes);
  fastify.register(liveRoutes);
  fastify.register(maintenanceRoutes);
}


