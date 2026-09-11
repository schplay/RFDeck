import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { parseScanText, toWwbCsv, exclusionsFromScan, type Scan } from '../scans/format';

// Spectrum scans: imported from the tools that took them, kept as one
// uniform shape, drawn under the frequency map and fed to the coordinator
// as exclusions. See docs/SCANNING.md.

const MAX_TEXT_BYTES = 8 * 1024 * 1024;

function meta(row: { id: string; name: string; source: string; takenAt: Date; startKHz: number; stepKHz: number; points: number; createdAt: Date }) {
  const { id, name, source, takenAt, startKHz, stepKHz, points, createdAt } = row;
  return {
    id, name, source, takenAt: takenAt.toISOString(), startKHz, stepKHz, points,
    endKHz: startKHz + (points - 1) * stepKHz, createdAt: createdAt.toISOString(),
  };
}

export function rowToScan(row: { source: string; takenAt: Date; startKHz: number; stepKHz: number; levels: string }): Scan {
  return {
    source: row.source, takenAt: row.takenAt.toISOString(),
    startKHz: row.startKHz, stepKHz: row.stepKHz,
    levelsDbm: JSON.parse(row.levels),
  };
}

export async function loadScan(id: string): Promise<Scan | null> {
  const row = await prisma.scan.findUnique({ where: { id } });
  return row ? rowToScan(row) : null;
}

export const scanRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/scans', async () => {
    const rows = await prisma.scan.findMany({ orderBy: { takenAt: 'desc' } });
    return rows.map(meta);
  });

  fastify.get('/scans/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.scan.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: 'Scan not found' });
    return { ...meta(row), levelsDbm: JSON.parse(row.levels) };
  });

  /** Import a scan file's text. The client reads the file; the server never sees a path. */
  fastify.post('/scans', async (request, reply) => {
    const d = (request.body ?? {}) as any;
    if (typeof d.text !== 'string' || !d.text.trim()) return reply.code(400).send({ error: 'text is required' });
    if (Buffer.byteLength(d.text) > MAX_TEXT_BYTES) return reply.code(413).send({ error: 'Scan file is too large' });
    const takenAt = typeof d.takenAt === 'string' && !Number.isNaN(Date.parse(d.takenAt)) ? d.takenAt : undefined;
    const scan = parseScanText(d.text, takenAt);
    if (!scan) return reply.code(400).send({ error: 'No frequency/level pairs found — expected lines like "470.100,-42.1" or "470000;;-106"' });
    const name = String(d.name ?? '').trim() || `Scan ${new Date(scan.takenAt).toLocaleString()}`;
    const row = await prisma.scan.create({
      data: {
        name, source: typeof d.source === 'string' && d.source ? d.source : scan.source,
        takenAt: new Date(scan.takenAt), startKHz: scan.startKHz, stepKHz: scan.stepKHz,
        points: scan.levelsDbm.length, levels: JSON.stringify(scan.levelsDbm),
      },
    });
    return reply.code(201).send(meta(row));
  });

  fastify.delete('/scans/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try { await prisma.scan.delete({ where: { id } }); }
    catch { return reply.code(404).send({ error: 'Scan not found' }); }
    return { ok: true };
  });

  /** The WWB pair form, which WSM and IAS read too. */
  fastify.get('/scans/:id/export.csv', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.scan.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: 'Scan not found' });
    const filename = `${row.name.replace(/[^\w.-]+/g, '_')}.csv`;
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(toWwbCsv(rowToScan(row)));
  });

  /** Where a coordinator should keep out of, given a threshold. */
  fastify.post('/scans/:id/exclusions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const d = (request.body ?? {}) as any;
    const threshold = Number(d.thresholdDbm);
    if (!Number.isFinite(threshold)) return reply.code(400).send({ error: 'thresholdDbm is required' });
    const margin = Number.isFinite(Number(d.marginKHz)) && Number(d.marginKHz) >= 0 ? Number(d.marginKHz) : 100;
    const scan = await loadScan(id);
    if (!scan) return reply.code(404).send({ error: 'Scan not found' });
    const exclusionsKHz = exclusionsFromScan(scan, threshold, margin);
    return { exclusionsKHz, thresholdDbm: threshold, marginKHz: margin };
  });
};
