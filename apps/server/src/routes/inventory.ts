import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { DeviceManagerService } from '../hardware/sennheiser/DeviceManagerService';
import { encryptSecret } from '../auth/secretBox';
import { inferDeviceRole } from '../hardware/deviceRole';

// Device passwords unlock the wireless hardware itself and must never reach a
// client. Every response goes through this — the client learns only whether a
// password is set, which is all the UI needs.
function publicDevice<T extends { password?: string | null }>(device: T) {
  const { password, ...rest } = device;
  return { ...rest, hasPassword: !!password };
}


/**
 * The inventory changed, as an event.
 *
 * "Online inventory listing" is a paid feature whose cloud endpoint does not exist
 * yet. Until it does, the *changes* travel as events, which costs nothing extra
 * and means the history is already there when the listing arrives rather than
 * starting from whenever it was built.
 *
 * Deliberately no password, ever — not even a boolean saying one exists. A device
 * password unlocks somebody's hardware and has no business in a stream.
 */
function emitInventoryEvent(
  fastify: any,
  verb: 'added' | 'changed' | 'removed',
  device: any,
  extra: Record<string, unknown> = {},
) {
  fastify.cloud?.emit?.({
    type: `rfdeck.inventory.${verb}`,
    severity: 'info',
    subject: { kind: 'device', id: device.id, name: device.name ?? undefined },
    attrs: {
      message: `${device.name ?? 'A device'} was ${verb}`,
      manufacturer: device.manufacturer,
      model: device.model,
      ip: device.ip,
      port: device.port,
      deviceType: device.deviceType,
      active: device.active,
      ...(device.location ? { location: device.location } : {}),
      ...(device.serial ? { serial: device.serial } : {}),
      ...(device.firmware ? { firmware: device.firmware } : {}),
      ...(device.band ? { band: device.band } : {}),
      ...extra,
    },
  });
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
        // The add form defaults this to "input", and a device added straight
        // from the discovery list is never asked at all — so an IEM
        // transmitter arrives filed as a microphone unless the model says
        // otherwise. An explicit "output" from the client always wins.
        deviceType: data.deviceType === 'output'
          ? 'output'
          : (inferDeviceRole(data.model, data.name) ?? data.deviceType ?? 'input'),
        // "output" from the add form is a deliberate act — the form defaults
        // to input, so nobody selects it by accident. Plain "input" is left
        // unmarked, so inference may still correct it later.
        deviceTypeManual: data.deviceType === 'output',
        active: data.active ?? true,
      }
    });

    // Tell device manager to start tracking it (unless added as inactive)
    if (device.active) {
      (fastify as any).deviceManager.trackDevice(device);
    }

    emitInventoryEvent(fastify, 'added', device);
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

    emitInventoryEvent(fastify, 'changed', device, { change: active ? 'activated' : 'deactivated' });
    return publicDevice(device);
  });

  // PATCH which receiver slots on one device are in use.
  //
  // Separate from `active`, which is all-or-nothing and therefore no use on a
  // multi-channel receiver: a two-channel unit with one radio on it reported a
  // healthy channel and a permanently disconnected one, and the only way to
  // silence the empty slot was to deactivate the device carrying the working
  // mic. Slots are 1-based and given as an array.
  fastify.patch('/inventory/:id/slots', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { disabledSlots } = request.body as { disabledSlots: unknown };

    if (!Array.isArray(disabledSlots)) {
      return reply.code(400).send({ error: 'disabledSlots must be an array of slot numbers' });
    }
    const slots = [...new Set(
      disabledSlots.map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 64),
    )].sort((a, b) => a - b);

    const device = await prisma.inventoryDevice.update({
      where: { id },
      data: { disabledSlots: slots.join(',') },
    });

    (fastify as any).deviceManager.setDisabledSlots(device, device.disabledSlots);
    emitInventoryEvent(fastify, 'changed', device, {
      change: 'slots', disabledSlots: device.disabledSlots || null,
    });
    (fastify as any).io.emit('device:slots-changed', {
      id: device.id, ip: device.ip, port: device.port, disabledSlots: device.disabledSlots,
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
        // Setting the type by hand makes it stick. Without this the startup
        // backfill would move an IEM-named device back to output on the next
        // restart, and an operator could never correct RFDeck's guess.
        deviceTypeManual: data.deviceType ? true : undefined,
        active: typeof data.active === 'boolean' ? data.active : undefined,
      }
    });

    // If IP/port changed, we should probably recreate the client
    (fastify as any).deviceManager.updateTrackedDevice(device);

    emitInventoryEvent(fastify, 'changed', device, { change: 'edited' });
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
      // Emitted after the delete succeeded, so the stream never records a removal
      // that did not happen.
      emitInventoryEvent(fastify, 'removed', device);
    }

    return { success: true };
  });
};

