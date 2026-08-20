import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';

// Shows are server-authoritative: RFDeck is a multi-client application, so a
// mic-check tick made backstage must appear at FOH immediately. Every mutation
// broadcasts over the socket rather than relying on clients to refetch.

const showInclude = {
  players:  { orderBy: { sortIndex: 'asc' } },
  micCheck: true,
} as const;

// Shape the DB rows into the client's Show model (acts keyed by act number,
// then by channel key) so the frontend store needs no translation layer.
function serializeShow(row: any) {
  const acts: Record<number, Record<string, any>> = {};
  for (const entry of row.micCheck ?? []) {
    (acts[entry.act] ??= {})[entry.channelKey] = {
      checked:   entry.checked,
      checkedAt: entry.checkedAt ? entry.checkedAt.toISOString() : undefined,
      checkedBy: entry.checkedBy ?? undefined,
      notes:     entry.notes ?? undefined,
    };
  }
  return {
    id:              row.id,
    name:            row.name,
    environmentMode: row.environmentMode,
    date:            row.date  ?? undefined,
    venue:           row.venue ?? undefined,
    notes:           row.notes ?? undefined,
    archived:        row.archived,
    archivedAt:      row.archivedAt ? row.archivedAt.toISOString() : undefined,
    players: (row.players ?? []).map((p: any) => ({
      id:                 p.id,
      showId:             p.showId,
      realName:           p.realName,
      characterName:      p.characterName,
      notes:              p.notes,
      assignedChannelKey: p.assignedChannelKey ?? null,
    })),
    micCheck: { currentAct: row.currentAct, acts },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const showRoutes: FastifyPluginAsync = async (fastify) => {
  const io = () => (fastify as any).io;

  // Re-read and broadcast. One helper keeps every mutation consistent — a
  // partial payload would let clients drift apart.
  const pushShow = async (id: string) => {
    const row = await prisma.show.findUnique({ where: { id }, include: showInclude });
    if (!row) return null;
    const show = serializeShow(row);
    io()?.emit('show:updated', show);
    return show;
  };

  fastify.get('/shows', async () => {
    const rows = await prisma.show.findMany({
      include: showInclude,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(serializeShow);
  });

  fastify.post('/shows', async (request) => {
    const d = request.body as any;
    const row = await prisma.show.create({
      data: {
        name:            String(d.name ?? '').trim() || 'Untitled Show',
        environmentMode: d.environmentMode ?? 'THEATER',
        date:            d.date  ?? null,
        venue:           d.venue ?? null,
        notes:           d.notes ?? null,
      },
      include: showInclude,
    });
    const show = serializeShow(row);
    io()?.emit('show:updated', show);
    return show;
  });

  fastify.put('/shows/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const d = request.body as any;

    // Archiving is a soft flag — stamp the time on the transition only, so
    // re-saving an already-archived show doesn't move its archive date.
    const existing = await prisma.show.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Show not found' });

    let archivedAt = existing.archivedAt;
    if (typeof d.archived === 'boolean' && d.archived !== existing.archived) {
      archivedAt = d.archived ? new Date() : null;
    }

    await prisma.show.update({
      where: { id },
      data: {
        name:            d.name            ?? undefined,
        environmentMode: d.environmentMode ?? undefined,
        date:  Object.prototype.hasOwnProperty.call(d, 'date')  ? (d.date  ?? null) : undefined,
        venue: Object.prototype.hasOwnProperty.call(d, 'venue') ? (d.venue ?? null) : undefined,
        notes: Object.prototype.hasOwnProperty.call(d, 'notes') ? (d.notes ?? null) : undefined,
        currentAct: typeof d.currentAct === 'number' ? d.currentAct : undefined,
        archived:   typeof d.archived   === 'boolean' ? d.archived  : undefined,
        archivedAt,
      },
    });
    return await pushShow(id);
  });

  fastify.delete('/shows/:id', async (request) => {
    const { id } = request.params as { id: string };
    await prisma.show.delete({ where: { id } }).catch(() => {});
    io()?.emit('show:deleted', { id });
    return { success: true };
  });

  // ── Players ──

  fastify.post('/shows/:id/players', async (request, reply) => {
    const { id } = request.params as { id: string };
    const d = request.body as any;
    const show = await prisma.show.findUnique({ where: { id } });
    if (!show) return reply.code(404).send({ error: 'Show not found' });

    const count = await prisma.player.count({ where: { showId: id } });
    await prisma.player.create({
      data: {
        showId:        id,
        realName:      String(d.realName ?? '').trim(),
        characterName: String(d.characterName ?? '').trim(),
        notes:         d.notes ?? '',
        sortIndex:     count,
      },
    });
    return await pushShow(id);
  });

  fastify.put('/shows/:id/players/:playerId', async (request) => {
    const { id, playerId } = request.params as { id: string; playerId: string };
    const d = request.body as any;
    await prisma.player.update({
      where: { id: playerId },
      data: {
        realName:      d.realName      ?? undefined,
        characterName: d.characterName ?? undefined,
        notes:         d.notes         ?? undefined,
        assignedChannelKey: Object.prototype.hasOwnProperty.call(d, 'assignedChannelKey')
          ? (d.assignedChannelKey || null)
          : undefined,
        sortIndex: typeof d.sortIndex === 'number' ? d.sortIndex : undefined,
      },
    }).catch(() => {});
    return await pushShow(id);
  });

  fastify.delete('/shows/:id/players/:playerId', async (request) => {
    const { id, playerId } = request.params as { id: string; playerId: string };
    await prisma.player.delete({ where: { id: playerId } }).catch(() => {});
    return await pushShow(id);
  });

  // ── Mic check ──

  fastify.put('/shows/:id/check', async (request, reply) => {
    const { id } = request.params as { id: string };
    const d = request.body as any;
    const act = Number(d.act);
    const channelKey = String(d.channelKey ?? '');
    if (!act || !channelKey) {
      return reply.code(400).send({ error: 'act and channelKey are required' });
    }

    const checked = typeof d.checked === 'boolean' ? d.checked : undefined;
    const notes   = Object.prototype.hasOwnProperty.call(d, 'notes') ? (d.notes ?? null) : undefined;

    const existing = await prisma.micCheckEntry.findUnique({
      where: { showId_act_channelKey: { showId: id, act, channelKey } },
    });

    // Stamp checkedAt when transitioning to checked; preserve the original
    // timestamp when unchecking so the history of the first check survives.
    const checkedAt =
      checked === true  ? new Date()
    : checked === false ? (existing?.checkedAt ?? null)
    : undefined;

    await prisma.micCheckEntry.upsert({
      where:  { showId_act_channelKey: { showId: id, act, channelKey } },
      create: {
        showId: id, act, channelKey,
        checked:   checked ?? false,
        checkedAt: checked ? new Date() : null,
        checkedBy: d.checkedBy ?? null,
        notes:     notes ?? null,
      },
      update: {
        checked,
        checkedAt,
        checkedBy: d.checkedBy ?? undefined,
        notes,
      },
    });

    const show = await pushShow(id);
    if (!show) return reply.code(404).send({ error: 'Show not found' });
    return show;
  });

  fastify.delete('/shows/:id/acts/:act', async (request) => {
    const { id, act } = request.params as { id: string; act: string };
    await prisma.micCheckEntry.deleteMany({
      where: { showId: id, act: Number(act) },
    });
    return await pushShow(id);
  });
};
