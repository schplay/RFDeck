import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { DeviceManagerService } from '../hardware/sennheiser/DeviceManagerService';

export const inventoryRoutes: FastifyPluginAsync = async (fastify, options) => {
  // POST trigger a one-shot network discovery scan
  fastify.post('/discovery/scan', async (request, reply) => {
    const dm = (fastify as any).deviceManager;
    // Fire-and-forget — results arrive via socket.io (device:discovered events)
    dm.triggerScan().catch(() => {});
    return { scanning: true };
  });

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
        notes: data.notes,
        password: data.password ?? null,
        deviceType: data.deviceType ?? 'input',
        active: data.active ?? true,
      }
    });

    // Tell device manager to start tracking it (unless added as inactive)
    if (device.active) {
      (fastify as any).deviceManager.trackDevice(device);
    }

    return device;
  });

  // PATCH set a device active/inactive.  Inactive devices are intentionally
  // powered off: untracked, hidden from the dashboard, and silent in the alert log.
  fastify.patch('/inventory/:id/active', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { active } = request.body as { active: boolean };

    const device = await prisma.inventoryDevice.update({
      where: { id },
      data: { active },
    });

    (fastify as any).deviceManager.setDeviceActive(device, active);
    (fastify as any).io.emit('device:active-changed', {
      id: device.id, ip: device.ip, port: device.port, active,
    });

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
        notes: data.notes,
        password: Object.prototype.hasOwnProperty.call(data, 'password') ? (data.password ?? null) : undefined,
        deviceType: data.deviceType ?? undefined,
        active: typeof data.active === 'boolean' ? data.active : undefined,
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

