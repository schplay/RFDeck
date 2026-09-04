import fs from 'fs';
import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { log } from '../logger';

// Detections: incidents that look like wireless faults, with the audio that
// proves them. Server-authoritative like everything else an operator acts on —
// a clip flagged at FOH is flagged backstage too.

export const detectionRoutes: FastifyPluginAsync = async (fastify) => {
  const recorder = () => (fastify as any).recordingManager;
  const io = () => (fastify as any).io;

  fastify.get('/detections', async (request) => {
    const q = request.query as Record<string, string | undefined>;

    const where: any = {};
    if (q.channel)  where.channelKey = q.channel;
    if (q.trigger)  where.trigger    = q.trigger;
    if (q.showId)   where.showId     = q.showId;
    if (q.flagged === '1') where.flagged = true;
    // Dismissed entries stay in the database for the report but leave the
    // working list, which is what an operator is triaging during a run.
    if (q.includeDismissed !== '1') where.dismissed = false;
    if (q.from || q.to) {
      where.timestamp = {};
      if (q.from) where.timestamp.gte = new Date(q.from);
      if (q.to)   where.timestamp.lte = new Date(q.to);
    }

    const take = Math.min(Number(q.limit) || 100, 500);
    const [detections, total] = await Promise.all([
      prisma.detection.findMany({ where, orderBy: { timestamp: 'desc' }, take }),
      prisma.detection.count({ where }),
    ]);
    return { detections, total, returned: detections.length };
  });

  // Flag, note, or dismiss. Flagging exempts the clip from FIFO pruning, so it
  // is the operator's way of saying "keep this one".
  fastify.patch('/detections/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const d = request.body as any;

    try {
      const updated = await prisma.detection.update({
        where: { id },
        data: {
          flagged:   typeof d?.flagged === 'boolean' ? d.flagged : undefined,
          dismissed: typeof d?.dismissed === 'boolean' ? d.dismissed : undefined,
          note:      typeof d?.note === 'string' ? d.note : undefined,
        },
      });
      io()?.emit('detection:updated', updated);
      return updated;
    } catch (err: any) {
      if (err?.code === 'P2025') return reply.code(404).send({ error: 'Detection not found' });
      request.log.error({ err }, 'Failed to update detection');
      return reply.code(500).send({ error: 'Could not save the change' });
    }
  });

  fastify.delete('/detections/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.detection.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Detection not found' });

    if (existing.clipPath) {
      const file = recorder()?.clipFile(existing.clipPath);
      if (file) await fs.promises.unlink(file).catch(() => {});
    }
    await prisma.detection.delete({ where: { id } });
    io()?.emit('detection:deleted', { id });
    return { success: true };
  });

  // The clip itself. Served as a plain file so an <audio> element can play it
  // and the browser can seek — this is review, not live monitoring, so it does
  // not go through the WebRTC path.
  fastify.get('/detections/:id/clip', async (request, reply) => {
    const { id } = request.params as { id: string };
    const detection = await prisma.detection.findUnique({ where: { id } });
    if (!detection?.clipPath) {
      return reply.code(404).send({ error: 'No clip for this detection' });
    }
    const file = recorder()?.clipFile(detection.clipPath);
    if (!file) {
      return reply.code(410).send({ error: 'The clip has been pruned to stay within the storage budget' });
    }
    reply
      .header('Content-Type', 'audio/wav')
      .header('Cache-Control', 'private, max-age=3600')
      .header('Content-Disposition',
        `inline; filename="${(detection.channelName ?? 'clip').replace(/[^\w.-]+/g, '-')}-${id.slice(0, 8)}.wav"`);
    return reply.send(fs.createReadStream(file));
  });

  // What recording is doing and what it is costing, including the disk behind
  // it — a budget with no sense of available space is a guess.
  fastify.get('/recording/status', async (_request, reply) => {
    const rec = recorder();
    if (!rec) return reply.code(503).send({ error: 'Recording is not available' });
    return rec.status();
  });

  // Re-read settings and patches. Called after the audio patch or the
  // recording settings change, so taps follow without a restart.
  fastify.post('/recording/reload', async (_request, reply) => {
    const rec = recorder();
    if (!rec) return reply.code(503).send({ error: 'Recording is not available' });
    try {
      await rec.reload();
      return rec.status();
    } catch (err: any) {
      log.warn(`[recording] Reload failed: ${err?.message}`);
      return reply.code(500).send({ error: 'Could not reload recording' });
    }
  });
};
