import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';

// Persisted event history — the timestamped record behind a post-show report.
// Both alerts and RF dropout/recovery land in the same table so a report can
// present one chronological account rather than two logs to reconcile.

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  // Quote when the value contains a delimiter, quote, or newline.
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const eventRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/events', async (request) => {
    const q = request.query as Record<string, string | undefined>;

    const where: any = {};
    if (q.source)   where.source   = q.source;
    if (q.severity) where.severity = q.severity;
    if (q.type)     where.type     = q.type;
    if (q.channel)  where.channelKey = q.channel;
    if (q.from || q.to) {
      where.timestamp = {};
      if (q.from) where.timestamp.gte = new Date(q.from);
      if (q.to)   where.timestamp.lte = new Date(q.to);
    }

    // Cap the page so a client can't ask for a year of history at once.
    const take = Math.min(Number(q.limit) || 200, 1000);

    const [events, total] = await Promise.all([
      prisma.event.findMany({ where, orderBy: { timestamp: 'desc' }, take }),
      prisma.event.count({ where }),
    ]);

    return { events, total, returned: events.length };
  });

  // CSV export of the same filtered set. Streams as a download rather than
  // JSON so it can go straight into a report or a spreadsheet.
  fastify.get('/events/export', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;

    const where: any = {};
    if (q.source)   where.source   = q.source;
    if (q.severity) where.severity = q.severity;
    if (q.from || q.to) {
      where.timestamp = {};
      if (q.from) where.timestamp.gte = new Date(q.from);
      if (q.to)   where.timestamp.lte = new Date(q.to);
    }

    const events = await prisma.event.findMany({
      where,
      orderBy: { timestamp: 'asc' },
      take: 20_000,
    });

    const header = [
      'Timestamp', 'Source', 'Type', 'Severity', 'Channel',
      'Device', 'RF A', 'RF B', 'Message', 'Acknowledged',
    ];

    const rows = events.map(e => [
      e.timestamp.toISOString(),
      e.source,
      e.type,
      e.severity,
      e.channelName ?? '',
      e.deviceId ?? '',
      e.rfLevelA ?? '',
      e.rfLevelB ?? '',
      e.message,
      e.acknowledged ? 'yes' : 'no',
    ].map(csvCell).join(','));

    const stamp = new Date().toISOString().slice(0, 10);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="rfdeck-events-${stamp}.csv"`);

    return [header.join(','), ...rows].join('\r\n');
  });

  fastify.delete('/events', async () => {
    const result = await prisma.event.deleteMany({});
    return { deleted: result.count };
  });
};
