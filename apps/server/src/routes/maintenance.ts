import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { log } from '../logger';

// The maintenance log for one piece of hardware: what has been done to it, and
// when. Server-authoritative like everything else an operator acts on, so a
// note written backstage is there at FOH.
//
// Distinct from the event log, which records what the *system* observed. This
// records what a person did with a screwdriver, and it is the only record of
// that — nothing about a replaced lavalier element is visible over the network.

const KINDS = new Set(['BATTERY', 'ELEMENT', 'REPAIR', 'FIRMWARE', 'SERVICE', 'NOTE']);

/** Long enough for a paragraph, short enough that a paste cannot fill the disk. */
const MAX_SUMMARY = 200;
const MAX_DETAIL = 4000;

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export const maintenanceRoutes: FastifyPluginAsync = async (fastify) => {
  const io = () => (fastify as any).io;

  fastify.get('/inventory/:deviceId/maintenance', async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };

    // 404 rather than an empty list: "no entries" and "no such device" are
    // different answers, and a client that silently shows an empty log for a
    // deleted device is lying.
    const device = await prisma.inventoryDevice.findUnique({ where: { id: deviceId } });
    if (!device) return reply.code(404).send({ error: 'No such device' });

    const entries = await prisma.maintenanceEntry.findMany({
      where: { deviceId },
      // Newest work first. `at` is when it happened; createdAt breaks ties so
      // two entries logged for the same day keep a stable order.
      orderBy: [{ at: 'desc' }, { createdAt: 'desc' }],
    });
    return { entries };
  });

  fastify.post('/inventory/:deviceId/maintenance', async (request, reply) => {
    const { deviceId } = request.params as { deviceId: string };
    const body = request.body as any;

    const device = await prisma.inventoryDevice.findUnique({ where: { id: deviceId } });
    if (!device) return reply.code(404).send({ error: 'No such device' });

    const summary = clean(body?.summary, MAX_SUMMARY);
    if (!summary) {
      return reply.code(400).send({ error: 'A summary is required' });
    }

    const kind = KINDS.has(body?.kind) ? body.kind : 'NOTE';

    // The operator picks when the work happened, because it is routinely
    // logged a day late. An unparseable or absent date means now.
    let at = new Date();
    if (body?.at) {
      const parsed = new Date(body.at);
      if (!Number.isNaN(parsed.getTime())) at = parsed;
    }

    const entry = await prisma.maintenanceEntry.create({
      data: { deviceId, kind, summary, detail: clean(body?.detail, MAX_DETAIL), at },
    });

    io()?.emit('maintenance:changed', { deviceId });
    log.info(`[maintenance] ${device.name}: ${kind} — ${summary}`);
    return entry;
  });

  fastify.patch('/inventory/:deviceId/maintenance/:id', async (request, reply) => {
    const { deviceId, id } = request.params as { deviceId: string; id: string };
    const body = request.body as any;

    const existing = await prisma.maintenanceEntry.findUnique({ where: { id } });
    if (!existing || existing.deviceId !== deviceId) {
      return reply.code(404).send({ error: 'No such entry' });
    }

    const summary = body?.summary !== undefined ? clean(body.summary, MAX_SUMMARY) : undefined;
    if (summary !== undefined && !summary) {
      return reply.code(400).send({ error: 'A summary is required' });
    }

    let at: Date | undefined;
    if (body?.at) {
      const parsed = new Date(body.at);
      if (!Number.isNaN(parsed.getTime())) at = parsed;
    }

    const entry = await prisma.maintenanceEntry.update({
      where: { id },
      data: {
        summary,
        detail: body?.detail !== undefined ? clean(body.detail, MAX_DETAIL) : undefined,
        kind: KINDS.has(body?.kind) ? body.kind : undefined,
        at,
        // Editing an automatic entry makes it the operator's. Leaving it
        // marked automatic would claim RFDeck observed something it did not.
        automatic: existing.automatic ? false : undefined,
      },
    });

    io()?.emit('maintenance:changed', { deviceId });
    return entry;
  });

  fastify.delete('/inventory/:deviceId/maintenance/:id', async (request, reply) => {
    const { deviceId, id } = request.params as { deviceId: string; id: string };

    const existing = await prisma.maintenanceEntry.findUnique({ where: { id } });
    if (!existing || existing.deviceId !== deviceId) {
      return reply.code(404).send({ error: 'No such entry' });
    }

    await prisma.maintenanceEntry.delete({ where: { id } });
    io()?.emit('maintenance:changed', { deviceId });
    return { ok: true };
  });
};
