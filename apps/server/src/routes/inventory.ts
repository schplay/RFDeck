import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { DeviceManagerService } from '../hardware/sennheiser/DeviceManagerService';
import { encryptSecret } from '../auth/secretBox';

// Device passwords unlock the wireless hardware itself and must never reach a
// client. Every response goes through this — the client learns only whether a
// password is set, which is all the UI needs.
function publicDevice<T extends { password?: string | null }>(device: T) {
  const { password, ...rest } = device;
  return { ...rest, hasPassword: !!password };
}

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
    return devices.map(publicDevice);
  });

  // POST new device
  fastify.post('/inventory', async (request, reply) => {
    const data = request.body as any;

    // Resolve the password to store, already encrypted.
    //
    // When the client supplies one, encrypt it. When it doesn't, fall back to
    // the configured default — which is already encrypted in the settings row,
    // so it is carried across as-is rather than encrypted twice. Resolving this
    // server-side means the stored credential never has to be sent to a client
    // in order to be useful.
    let storedPassword: string | null = null;
    if (data.password) {
      storedPassword = encryptSecret(data.password);
    } else {
      const settings = await prisma.settings.findFirst();
      storedPassword = settings?.defaultPassword ?? null;
    }

    const device = await prisma.inventoryDevice.create({
      data: {
        name: data.name,
        manufacturer: data.manufacturer,
        model: data.model,
        ip: data.ip,
        port: data.port,
        location: data.location,
        notes: data.notes,
        password: storedPassword,
        deviceType: data.deviceType ?? 'input',
        active: data.active ?? true,
      }
    });

    // Tell device manager to start tracking it (unless added as inactive)
    if (device.active) {
      (fastify as any).deviceManager.trackDevice(device);
    }

    return publicDevice(device);
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

    return publicDevice(device);
  });

  // PATCH set every device active/inactive at once — the start-of-day /
  // end-of-day switch. Powering a rack down without disabling first floods
  // the log with dropouts; doing it one device at a time on a large rack is
  // why nobody bothers. Only devices whose state actually changes are touched.
  fastify.patch('/inventory/active', async (request) => {
    const { active } = request.body as { active: boolean };

    const toChange = await prisma.inventoryDevice.findMany({
      where: { active: { not: active } },
    });

    for (const device of toChange) {
      await prisma.inventoryDevice.update({ where: { id: device.id }, data: { active } });
      (fastify as any).deviceManager.setDeviceActive(device, active);
      (fastify as any).io.emit('device:active-changed', {
        id: device.id, ip: device.ip, port: device.port, active,
      });
    }

    return { changed: toChange.length, active };
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
        password: Object.prototype.hasOwnProperty.call(data, 'password')
          ? encryptSecret(data.password ?? null)
          : undefined,
        deviceType: data.deviceType ?? undefined,
        active: typeof data.active === 'boolean' ? data.active : undefined,
      }
    });

    // If IP/port changed, we should probably recreate the client
    (fastify as any).deviceManager.updateTrackedDevice(device);

    return publicDevice(device);
  });

  // Reconnect now, rather than waiting for the next probe.
  //
  // The SSC client stops retrying a refused subscription on purpose — hammering
  // a device with a wrong password is not useful — so after fixing the password
  // the operator needs a way to say "try again". Re-tracking builds a fresh
  // client with the stored credentials, which is exactly what a password save
  // does; this just makes it available on its own.
  fastify.post('/inventory/:id/reconnect', async (request, reply) => {
    const { id } = request.params as { id: string };
    const device = await prisma.inventoryDevice.findUnique({ where: { id } });
    if (!device) return reply.code(404).send({ error: 'Device not found' });
    if (device.active === false) {
      return reply.code(409).send({ error: 'Device is inactive; activate it to connect.' });
    }
    (fastify as any).deviceManager.updateTrackedDevice(device);
    return { success: true };
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

