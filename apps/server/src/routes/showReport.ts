import { FastifyPluginAsync } from 'fastify';
import { buildShowReport, reportToCsv, reportToHtml, ReportBattery } from '../reports/showReport';

// Show report, in three forms from one builder:
//   /shows/:id/report        JSON — for anything that wants the data
//   /shows/:id/report.csv    spreadsheet download
//   /shows/:id/report.html   printable page; the browser's print dialog is the
//                            PDF path, so no PDF dependency is carried
//
// Optional ?from= and ?to= (ISO timestamps) override the event window, which
// otherwise spans the show's own lifetime.

export const showReportRoutes: FastifyPluginAsync = async (fastify) => {
  // Battery is live state held by the device manager, not history. Pair each
  // estimate with the channel's current percentage so the report reads as one
  // line per channel rather than two lists to cross-reference.
  const liveBattery = (): ReportBattery[] => {
    const dm = (fastify as any).deviceManager;
    if (!dm) return [];
    const channels: any[] = dm.getChannelSnapshot?.() ?? [];
    const estimates: any[] = dm.getBatteryEstimateSnapshot?.() ?? [];
    const byId = new Map(channels.map(c => [c.id, c]));
    return estimates.map(est => {
      const ch = byId.get(est.channelId);
      return {
        channel: ch?.name || est.channelId,
        percent: typeof ch?.batteryPercent === 'number' ? ch.batteryPercent : null,
        minutesRemaining: est.minutesRemaining ?? null,
        confident: !!est.confident,
      };
    }).sort((a, b) => a.channel.localeCompare(b.channel));
  };

  const build = async (request: any, reply: any) => {
    const { id } = request.params as { id: string };
    const q = request.query as Record<string, string | undefined>;
    const report = await buildShowReport(id, { from: q.from, to: q.to }, liveBattery());
    if (!report) {
      reply.code(404).send({ error: 'Show not found' });
      return null;
    }
    return report;
  };

  const safeName = (name: string) =>
    name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'show';

  fastify.get('/shows/:id/report', async (request, reply) => {
    return (await build(request, reply)) ?? reply;
  });

  fastify.get('/shows/:id/report.csv', async (request, reply) => {
    const report = await build(request, reply);
    if (!report) return reply;
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition',
        `attachment; filename="rfdeck-${safeName(report.show.name)}-${report.generatedAt.slice(0, 10)}.csv"`);
    return reportToCsv(report);
  });

  fastify.get('/shows/:id/report.html', async (request, reply) => {
    const report = await build(request, reply);
    if (!report) return reply;
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reportToHtml(report);
  });
};
