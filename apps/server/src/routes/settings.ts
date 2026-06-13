import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';

export const settingsRoutes: FastifyPluginAsync = async (fastify, options) => {
  // GET global settings
  fastify.get('/settings', async (request, reply) => {
    let settings = await prisma.settings.findFirst();
    if (!settings) {
      settings = await prisma.settings.create({ data: {} });
    }
    return settings;
  });

  // PUT update global settings
  fastify.put('/settings', async (request, reply) => {
    const data = request.body as any;
    
    let settings = await prisma.settings.findFirst();
    if (!settings) {
      settings = await prisma.settings.create({ data: {} });
    }

    settings = await prisma.settings.update({
      where: { id: settings.id },
      data: {
        aes67MulticastIp: data.aes67MulticastIp,
        aes67Port: data.aes67Port,
        batteryWarningPct: data.batteryWarningPct,
        batteryCriticalPct: data.batteryCriticalPct,
        dropoutSensitivity: data.dropoutSensitivity,
        bindInterface: data.bindInterface
      }
    });

    return settings;
  });
};
