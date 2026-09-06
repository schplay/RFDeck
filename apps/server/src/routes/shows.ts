import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { findOrCreatePerformer, listPerformers } from '../performers/roster';

// Shows are server-authoritative: RFDeck is a multi-client application, so a
// mic-check tick made backstage must appear at FOH immediately. Every mutation
// broadcasts over the socket rather than relying on clients to refetch.

/**
 * How many acts, services or sets a show runs to.
 *
 * Clamped rather than trusted. Zero would leave a production with no period to
 * check a microphone in, and an unbounded number is a wall of tabs nobody can
 * use — both are easy to type by accident and neither is recoverable from
 * without editing the database.
 */
export const MIN_PERIODS = 1;
export const MAX_PERIODS = 12;

function clampPeriods(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 4;
  return Math.min(MAX_PERIODS, Math.max(MIN_PERIODS, n));
}

export const showInclude = {
  players: {
    orderBy: { sortIndex: 'asc' },
    include: {
      quickChanges: { orderBy: { sortIndex: 'asc' } },
      // The report prints how each person is rigged, which lives on the roster.
      performer: true,
    },
  },
  micCheck: true,
} as const;

// Shape the DB rows into the client's Show model (acts keyed by act number,
// then by channel key) so the frontend store needs no translation layer.
export function serializeShow(row: any) {
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
    periodCount:     row.periodCount,
    date:            row.date  ?? undefined,
    venue:           row.venue ?? undefined,
    notes:           row.notes ?? undefined,
    archived:        row.archived,
    archivedAt:      row.archivedAt ? row.archivedAt.toISOString() : undefined,
    players: (row.players ?? []).map((p: any) => ({
      id:                 p.id,
      showId:             p.showId,
      performerId:        p.performerId ?? null,
      realName:           p.realName,
      characterName:      p.characterName,
      notes:              p.notes,
      assignedChannelKey: p.assignedChannelKey ?? null,
      iemChannelKey:      p.iemChannelKey ?? null,
      quickChanges: (p.quickChanges ?? []).map((q: any) => ({
        id:        q.id,
        playerId:  q.playerId,
        act:       q.act ?? null,
        outCue:    q.outCue ?? '',
        inCue:     q.inCue ?? '',
        notes:     q.notes ?? '',
        sortIndex: q.sortIndex,
      })),
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
        // Clamped rather than trusted: a show with zero periods has no mic
        // check at all, and an absurd count is a wall of empty tabs.
        periodCount:     clampPeriods(d.periodCount),
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
        periodCount: Object.prototype.hasOwnProperty.call(d, 'periodCount')
                       ? clampPeriods(d.periodCount) : undefined,
        currentAct: typeof d.currentAct === 'number' ? d.currentAct : undefined,
        archived:   typeof d.archived   === 'boolean' ? d.archived  : undefined,
        archivedAt,
      },
    });
    return await pushShow(id);
  });

  fastify.delete('/shows/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await prisma.show.delete({ where: { id } });
    } catch (err: any) {
      // Never report success on a failed delete — the client would drop the
      // show from its list while the record survived on the server, and the
      // two would silently disagree until the next reload.
      if (err?.code === 'P2025') {
        return reply.code(404).send({ error: 'Show not found' });
      }
      request.log.error({ err }, 'Failed to delete show');
      return reply.code(500).send({ error: 'Could not delete the show' });
    }
    io()?.emit('show:deleted', { id });
    return { success: true };
  });

  // ── Players ──

  fastify.post('/shows/:id/players', async (request, reply) => {
    const { id } = request.params as { id: string };
    const d = request.body as any;
    const show = await prisma.show.findUnique({ where: { id } });
    if (!show) return reply.code(404).send({ error: 'Show not found' });

    // Cast either an existing performer or a name. A typed name joins the
    // roster rather than living only in this show, so the next show can pick
    // the same person instead of retyping them — that is the point of having
    // a roster at all.
    let performer: { id: string; name: string } | null = null;
    if (typeof d.performerId === 'string' && d.performerId) {
      performer = await prisma.performer.findUnique({ where: { id: d.performerId } });
      if (!performer) return reply.code(404).send({ error: 'Performer not found' });
    } else {
      const name = String(d.realName ?? '').trim();
      if (!name) return reply.code(400).send({ error: 'A performer or a name is required' });
      performer = await findOrCreatePerformer(name);
    }

    const count = await prisma.player.count({ where: { showId: id } });
    await prisma.player.create({
      data: {
        showId:        id,
        performerId:   performer.id,
        realName:      performer.name,
        characterName: String(d.characterName ?? '').trim(),
        notes:         d.notes ?? '',
        sortIndex:     count,
      },
    });
    // The roster may have grown, and casting counts changed either way.
    io()?.emit('performers:updated', await listPerformers());
    return await pushShow(id);
  });

  fastify.put('/shows/:id/players/:playerId', async (request, reply) => {
    const { id, playerId } = request.params as { id: string; playerId: string };
    const d = request.body as any;
    // Recasting: point this slot at a different roster entry. The name follows
    // the performer; a casting's name is never edited directly any more.
    let recast: { id: string; name: string } | null = null;
    if (typeof d.performerId === 'string' && d.performerId) {
      recast = await prisma.performer.findUnique({ where: { id: d.performerId } });
      if (!recast) return reply.code(404).send({ error: 'Performer not found' });
    }

    try {
      await prisma.player.update({
        where: { id: playerId },
        data: {
          performerId:   recast ? recast.id   : undefined,
          realName:      recast ? recast.name : (d.realName ?? undefined),
          characterName: d.characterName ?? undefined,
          notes:         d.notes         ?? undefined,
          assignedChannelKey: Object.prototype.hasOwnProperty.call(d, 'assignedChannelKey')
            ? (d.assignedChannelKey || null)
            : undefined,
          iemChannelKey: Object.prototype.hasOwnProperty.call(d, 'iemChannelKey')
            ? (d.iemChannelKey || null)
            : undefined,
          sortIndex: typeof d.sortIndex === 'number' ? d.sortIndex : undefined,
        },
      });
      if (recast) io()?.emit('performers:updated', await listPerformers());
    } catch (err: any) {
      if (err?.code === 'P2025') return reply.code(404).send({ error: 'Player not found' });
      request.log.error({ err }, 'Failed to update player');
      return reply.code(500).send({ error: 'Could not save the change' });
    }
    return await pushShow(id);
  });

  fastify.delete('/shows/:id/players/:playerId', async (request, reply) => {
    const { id, playerId } = request.params as { id: string; playerId: string };
    try {
      await prisma.player.delete({ where: { id: playerId } });
      io()?.emit('performers:updated', await listPerformers()); // casting counts
    } catch (err: any) {
      if (err?.code === 'P2025') return reply.code(404).send({ error: 'Player not found' });
      request.log.error({ err }, 'Failed to delete player');
      return reply.code(500).send({ error: 'Could not remove the player' });
    }
    return await pushShow(id);
  });

  // ── Quick changes ──
  //
  // A costume change that takes the pack off and puts it back on, with the
  // cues either side. Theatre business — the roster page hides this section
  // for environments that do not work that way (see ENVIRONMENTS).

  fastify.post('/shows/:id/players/:playerId/changes', async (request, reply) => {
    const { id, playerId } = request.params as { id: string; playerId: string };
    const d = request.body as any;

    const player = await prisma.player.findUnique({ where: { id: playerId } });
    if (!player || player.showId !== id) {
      return reply.code(404).send({ error: 'Casting not found in this show' });
    }

    const count = await prisma.quickChange.count({ where: { playerId } });
    await prisma.quickChange.create({
      data: {
        playerId,
        act:       typeof d?.act === 'number' ? d.act : null,
        outCue:    String(d?.outCue ?? ''),
        inCue:     String(d?.inCue ?? ''),
        notes:     String(d?.notes ?? ''),
        sortIndex: count,
      },
    });
    return await pushShow(id);
  });

  fastify.put('/shows/:id/players/:playerId/changes/:changeId', async (request, reply) => {
    const { id, changeId } = request.params as { id: string; changeId: string };
    const d = request.body as any;
    try {
      await prisma.quickChange.update({
        where: { id: changeId },
        data: {
          act: Object.prototype.hasOwnProperty.call(d, 'act')
                 ? (typeof d.act === 'number' ? d.act : null) : undefined,
          outCue: typeof d?.outCue === 'string' ? d.outCue : undefined,
          inCue:  typeof d?.inCue  === 'string' ? d.inCue  : undefined,
          notes:  typeof d?.notes  === 'string' ? d.notes  : undefined,
          sortIndex: typeof d?.sortIndex === 'number' ? d.sortIndex : undefined,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2025') return reply.code(404).send({ error: 'Quick change not found' });
      request.log.error({ err }, 'Failed to update quick change');
      return reply.code(500).send({ error: 'Could not save the change' });
    }
    return await pushShow(id);
  });

  fastify.delete('/shows/:id/players/:playerId/changes/:changeId', async (request, reply) => {
    const { id, changeId } = request.params as { id: string; changeId: string };
    try {
      await prisma.quickChange.delete({ where: { id: changeId } });
    } catch (err: any) {
      if (err?.code === 'P2025') return reply.code(404).send({ error: 'Quick change not found' });
      request.log.error({ err }, 'Failed to delete quick change');
      return reply.code(500).send({ error: 'Could not remove it' });
    }
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
