import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { listPerformers } from '../performers/roster';
import { showInclude, serializeShow } from './shows';

// The performer roster. Server-authoritative and broadcast like shows are:
// the whole list on every change, since it is small and a partial update
// would let two clients' rosters drift.

export const performerRoutes: FastifyPluginAsync = async (fastify) => {
  const io = () => (fastify as any).io;

  const push = async () => {
    const list = await listPerformers();
    io()?.emit('performers:updated', list);
    return list;
  };

  // Castings display the performer's name, so a rename has to reach every
  // show the person is in — and those shows' clients.
  const pushAffectedShows = async (performerId: string) => {
    const showIds = await prisma.player.findMany({
      where:    { performerId },
      select:   { showId: true },
      distinct: ['showId'],
    });
    for (const { showId } of showIds) {
      const row = await prisma.show.findUnique({ where: { id: showId }, include: showInclude });
      if (row) io()?.emit('show:updated', serializeShow(row));
    }
  };

  fastify.get('/performers', async () => listPerformers());

  fastify.post('/performers', async (request, reply) => {
    const d = request.body as any;
    const name = String(d?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'A name is required' });
    await prisma.performer.create({
      data: { name, notes: typeof d?.notes === 'string' ? d.notes : '' },
    });
    return push();
  });

  fastify.put('/performers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const d = request.body as any;

    const data: { name?: string; notes?: string } = {};
    if (typeof d?.name === 'string') {
      const name = d.name.trim();
      if (!name) return reply.code(400).send({ error: 'A name cannot be empty' });
      data.name = name;
    }
    if (typeof d?.notes === 'string') data.notes = d.notes;

    try {
      const updated = await prisma.performer.update({ where: { id }, data });
      if (data.name !== undefined) {
        await prisma.player.updateMany({
          where: { performerId: id },
          data:  { realName: updated.name },
        });
        await pushAffectedShows(id);
      }
    } catch (err: any) {
      if (err?.code === 'P2025') return reply.code(404).send({ error: 'Performer not found' });
      request.log.error({ err }, 'Failed to update performer');
      return reply.code(500).send({ error: 'Could not save the change' });
    }
    return push();
  });

  // Removing a performer leaves their castings in place with the name they
  // had — a past show's cast list is a record, not a live reference.
  fastify.delete('/performers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await prisma.performer.delete({ where: { id } });
    } catch (err: any) {
      if (err?.code === 'P2025') return reply.code(404).send({ error: 'Performer not found' });
      request.log.error({ err }, 'Failed to delete performer');
      return reply.code(500).send({ error: 'Could not remove the performer' });
    }
    return push();
  });
};
