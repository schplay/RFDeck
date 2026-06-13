import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { DeviceManagerService } from '../hardware/sennheiser/DeviceManagerService';

export const inventoryRoutes: FastifyPluginAsync = async (fastify, options) => {
  // GET all inventory devices
  fastify.get('/inventory', async (request, reply) => {
    const devices = await prisma.inventoryDevice.findMany();
    return devices;
  });

  // POST new device
  fastify.post('/inventory', async (request, reply) => {
    const data = request.body as any;
    const device = await prisma.inventoryDevice.create({
      data: {
        name: data.name,
        manufacturer: data.manufacturer,
        model: data.model,
        ip: data.ip,
        port: data.port,
        location: data.location,
        notes: data.notes
      }
    });

    // Tell device manager to start tracking it
    (fastify as any).deviceManager.trackDevice(device);

    return device;
  });

  // PUT update device
  fastify.put('/inventory/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = request.body as any;
    
    const device = await prisma.inventoryDevice.update({
      where: { id },
      data: {
        name: data.name,
        manufacturer: data.manufacturer,
        model: data.model,
        ip: data.ip,
        port: data.port,
        location: data.location,
        notes: data.notes
      }
    });

    // If IP/port changed, we should probably recreate the client
    (fastify as any).deviceManager.updateTrackedDevice(device);

    return device;
  });

  // DELETE device
  fastify.delete('/inventory/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    
    const device = await prisma.inventoryDevice.findUnique({ where: { id } });
    if (device) {
      await prisma.inventoryDevice.delete({ where: { id } });
      (fastify as any).deviceManager.untrackDevice(device.ip, device.port);
    }

    return { success: true };
  });
};

