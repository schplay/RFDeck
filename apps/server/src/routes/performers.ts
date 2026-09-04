import fs from 'fs';
import path from 'path';
import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { listPerformers } from '../performers/roster';
import { decodeDataUrl, resolveImagesDir, photoFile, contentTypeFor } from '../performers/photos';
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

    const data: { name?: string; notes?: string; fitNotes?: string } = {};
    if (typeof d?.name === 'string') {
      const name = d.name.trim();
      if (!name) return reply.code(400).send({ error: 'A name cannot be empty' });
      data.name = name;
    }
    if (typeof d?.notes === 'string') data.notes = d.notes;
    if (typeof d?.fitNotes === 'string') data.fitNotes = d.fitNotes;

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

  // ── Headshot ──
  //
  // Sent as a base64 data URL rather than multipart: the client resizes before
  // uploading, so payloads are small, and this needs no upload dependency on a
  // server that has to build on a bare Ubuntu box.
  fastify.post('/performers/:id/photo', {
    // Generous enough for the resized image plus base64's third; the decoder
    // enforces the real limit on the bytes themselves.
    bodyLimit: 8 * 1024 * 1024,
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const performer = await prisma.performer.findUnique({ where: { id } });
    if (!performer) return reply.code(404).send({ error: 'Performer not found' });

    const decoded = decodeDataUrl((request.body as any)?.image);
    if ('error' in decoded) return reply.code(400).send({ error: decoded.error });

    const dir = resolveImagesDir();
    await fs.promises.mkdir(dir, { recursive: true });

    const filename = `${id}.${decoded.extension}`;
    await fs.promises.writeFile(path.join(dir, filename), decoded.bytes);

    // A different format replaces the extension, so drop the previous file
    // rather than leaving an orphan behind.
    if (performer.photoPath && performer.photoPath !== filename) {
      const old = photoFile(performer.photoPath);
      if (old) await fs.promises.unlink(old).catch(() => {});
    }

    await prisma.performer.update({ where: { id }, data: { photoPath: filename } });
    return push();
  });

  fastify.get('/performers/:id/photo', async (request, reply) => {
    const { id } = request.params as { id: string };
    const performer = await prisma.performer.findUnique({ where: { id } });
    const file = photoFile(performer?.photoPath);
    if (!file) return reply.code(404).send({ error: 'No photo for this performer' });

    return reply
      // Our own content type, derived from the stored extension — never one
      // supplied by whoever uploaded the file.
      .header('Content-Type', contentTypeFor(file))
      .header('Cache-Control', 'private, max-age=300')
      .send(fs.createReadStream(file));
  });

  fastify.delete('/performers/:id/photo', async (request, reply) => {
    const { id } = request.params as { id: string };
    const performer = await prisma.performer.findUnique({ where: { id } });
    if (!performer) return reply.code(404).send({ error: 'Performer not found' });

    const file = photoFile(performer.photoPath);
    if (file) await fs.promises.unlink(file).catch(() => {});
    await prisma.performer.update({ where: { id }, data: { photoPath: null } });
    return push();
  });

  // Removing a performer leaves their castings in place with the name they
  // had — a past show's cast list is a record, not a live reference.
  fastify.delete('/performers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      // Take the headshot with them; an orphaned file would linger forever
      // with nothing left pointing at it.
      const existing = await prisma.performer.findUnique({ where: { id } });
      const file = photoFile(existing?.photoPath);
      if (file) await fs.promises.unlink(file).catch(() => {});

      await prisma.performer.delete({ where: { id } });
    } catch (err: any) {
      if (err?.code === 'P2025') return reply.code(404).send({ error: 'Performer not found' });
      request.log.error({ err }, 'Failed to delete performer');
      return reply.code(500).send({ error: 'Could not remove the performer' });
    }
    return push();
  });
};
