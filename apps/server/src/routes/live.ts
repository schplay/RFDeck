import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { log } from '../logger';

// Going live: the operator saying "I am working the rig now."
//
// One action, because these three always belong together and doing them
// separately is how one gets forgotten. Going live tracks every device in the
// inventory, starts rolling capture and fault detection, and puts the show's
// cast on the Micboard. Standing down reverses all three — the lights-off
// switch at the end of a day, which is also what keeps the log free of
// dropouts from receivers that were simply switched off.

async function settingsRow() {
  return (await prisma.settings.findFirst()) ?? (await prisma.settings.create({ data: {} }));
}

export const liveRoutes: FastifyPluginAsync = async (fastify) => {
  const io = () => (fastify as any).io;
  const deviceManager = () => (fastify as any).deviceManager;
  const recorder = () => (fastify as any).recordingManager;

  const state = async () => {
    const s = await settingsRow();
    const show = s.liveShowId
      ? await prisma.show.findUnique({ where: { id: s.liveShowId } })
      : null;
    return {
      live: s.liveStartedAt !== null,
      startedAt: s.liveStartedAt ? s.liveStartedAt.toISOString() : null,
      show: show ? { id: show.id, name: show.name, currentAct: show.currentAct } : null,
    };
  };

  const broadcast = async () => {
    const next = await state();
    io()?.emit('live:changed', next);
    return next;
  };

  // Open to the Micboard, which needs to know whether to show a cast or say
  // that nothing is running. See the PIN exemption in app.ts.
  fastify.get('/live', async () => state());

  fastify.post('/live', async (request, reply) => {
    const { showId } = (request.body ?? {}) as { showId?: string | null };

    if (showId) {
      const show = await prisma.show.findUnique({ where: { id: showId } });
      if (!show) return reply.code(404).send({ error: 'Show not found' });
      // Going live with an archived show is almost certainly a mistake — the
      // cast on the wall would be from a production that has finished.
      if (show.archived) {
        return reply.code(409).send({ error: `"${show.name}" is archived. Restore it first, or go live without a show.` });
      }
    }

    const s = await settingsRow();
    await prisma.settings.update({
      where: { id: s.id },
      data: { liveStartedAt: new Date(), liveShowId: showId ?? null },
    });

    // Every device back under RFDeck's eye. Only rows that actually change are
    // touched, and each broadcasts so every client follows.
    const toEnable = await prisma.inventoryDevice.findMany({ where: { active: false } });
    for (const device of toEnable) {
      await prisma.inventoryDevice.update({ where: { id: device.id }, data: { active: true } });
      deviceManager()?.setDeviceActive(device, true);
      io()?.emit('device:active-changed', {
        id: device.id, ip: device.ip, port: device.port, active: true,
      });
    }

    // Capture and detection read their configuration on reload, and the live
    // flag is part of it.
    await recorder()?.reload().catch(() => {});

    log.info(`[live] Going live${showId ? ` with show ${showId}` : ' with no show'}; enabled ${toEnable.length} device(s)`);
    return { ...(await broadcast()), enabled: toEnable.length };
  });

  fastify.delete('/live', async () => {
    const s = await settingsRow();
    await prisma.settings.update({
      where: { id: s.id },
      data: { liveStartedAt: null, liveShowId: null },
    });

    // Stop recording before disabling devices, so the taps are released rather
    // than being torn out from under a capture that is mid-write.
    await recorder()?.reload().catch(() => {});

    const toDisable = await prisma.inventoryDevice.findMany({ where: { active: true } });
    for (const device of toDisable) {
      await prisma.inventoryDevice.update({ where: { id: device.id }, data: { active: false } });
      deviceManager()?.setDeviceActive(device, false);
      io()?.emit('device:active-changed', {
        id: device.id, ip: device.ip, port: device.port, active: false,
      });
    }

    log.info(`[live] Standing down; disabled ${toDisable.length} device(s)`);
    return { ...(await broadcast()), disabled: toDisable.length };
  });
};
