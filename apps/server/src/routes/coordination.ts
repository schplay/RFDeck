import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { buildRig } from '../hardware/coordination/service';
import { coordinate, type CoordinationInput } from '../hardware/coordination/solver';
import { profileFor, familyOf, bandIsReported } from '../hardware/coordination/profiles';
import { log } from '../logger';
import { loadScan } from './scans';
import { exclusionsFromScan } from '../scans/format';

// Frequency coordination: plan a clean set of carriers for the live rig, and
// push it to the hardware.
//
// The plan is computed on request rather than continuously — it is an
// operator's decision, not a background finding (that is intermod's job).
// Applying it is the most disruptive thing RFDeck can be asked to do, so
// the route takes an explicit list of what to move and reports what each
// device said, rather than a single "done".

const MAX_PLAN_TRANSMITTERS = 200;

function readExclusions(raw: unknown): Array<[number, number]> {
  if (!Array.isArray(raw)) return [];
  const out: Array<[number, number]> = [];
  for (const e of raw) {
    if (!Array.isArray(e) || e.length !== 2) continue;
    const lo = Number(e[0]), hi = Number(e[1]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) continue;
    out.push([Math.round(lo), Math.round(hi)]);
  }
  return out;
}

export const coordinationRoutes: FastifyPluginAsync = async (fastify) => {
  const dm = () => (fastify as any).deviceManager;

  const loadRig = async () => {
    const rows = await prisma.inventoryDevice.findMany();
    return buildRig(rows, dm()?.getChannelSnapshot?.() ?? []);
  };

  /** What can be coordinated right now, and what each device still needs. */
  fastify.get('/coordination/rig', async () => {
    const rig = await loadRig();
    return { devices: rig.devices, skipped: rig.skipped, transmitterCount: rig.transmitters.length };
  });

  /** Compute a plan. Nothing is sent to hardware here. */
  fastify.post('/coordination/plan', async (request, reply) => {
    const d = (request.body ?? {}) as any;
    const rig = await loadRig();
    if (rig.transmitters.length > MAX_PLAN_TRANSMITTERS) {
      return reply.code(400).send({ error: `More than ${MAX_PLAN_TRANSMITTERS} transmitters; split the rig` });
    }
    const lockedIds = new Set<string>(Array.isArray(d.lockedIds) ? d.lockedIds.map(String) : []);

    // Keep out of what a scan shows above a threshold — WWB's "exclude
    // occupied frequencies", with the threshold the operator's.
    const exclusionsKHz = readExclusions(d.exclusionsKHz);
    let scanExclusions = 0;
    if (typeof d.scanId === 'string' && d.scanId) {
      const scan = await loadScan(d.scanId);
      if (!scan) return reply.code(404).send({ error: 'Scan not found' });
      const threshold = Number(d.scanThresholdDbm);
      if (!Number.isFinite(threshold)) return reply.code(400).send({ error: 'scanThresholdDbm is required with scanId' });
      const margin = Number.isFinite(Number(d.scanMarginKHz)) && Number(d.scanMarginKHz) >= 0 ? Number(d.scanMarginKHz) : 100;
      const spans = exclusionsFromScan(scan, threshold, margin);
      scanExclusions = spans.length;
      exclusionsKHz.push(...spans);
    }

    const input: CoordinationInput = {
      transmitters: rig.transmitters.map(t => lockedIds.has(t.id) ? { ...t, locked: true } : t),
      exclusionsKHz,
      guardKHz: Number.isFinite(Number(d.guardKHz)) && Number(d.guardKHz) >= 0 ? Number(d.guardKHz) : undefined,
      threeTx: ['required', 'preferred', 'ignored'].includes(d.threeTx) ? d.threeTx : undefined,
      includeFifthOrder: !!d.includeFifthOrder,
    };
    const started = Date.now();
    const plan = coordinate(input);
    log.info(
      `[coordination] planned ${plan.assignments.length}/${rig.transmitters.length} transmitters in ` +
      `${Date.now() - started} ms: ${plan.moves} move(s), 2TX margin ${plan.worstMarginKHz ?? '—'} kHz, ` +
      `3TX ${plan.threeTxCleared ? 'cleared' : 'not cleared'}`,
    );
    return { plan, devices: rig.devices, skipped: rig.skipped, scanExclusions };
  });

  /**
   * Declare a device's band, for the families whose receivers do not report
   * it. A reported band cannot be overwritten from here: the hardware is
   * the truth about itself, and a person "correcting" it would only make
   * the plan wrong.
   */
  fastify.put('/coordination/devices/:id/band', async (request, reply) => {
    const { id } = request.params as { id: string };
    const d = (request.body ?? {}) as any;
    const device = await prisma.inventoryDevice.findUnique({ where: { id } });
    if (!device) return reply.code(404).send({ error: 'Device not found' });

    const family = familyOf(device.manufacturer, device.model);
    if (!family) return reply.code(400).send({ error: 'RFDeck cannot tune this model' });
    if (device.bandSource === 'reported') {
      return reply.code(409).send({ error: `The receiver reports its band as ${device.band}; it cannot be declared` });
    }

    const patch: Record<string, unknown> = {};
    if (d.band === null || d.band === '') {
      patch.band = null; patch.bandSource = null;
    } else if (typeof d.band === 'string') {
      const profile = profileFor(family, d.band);
      if (!profile) return reply.code(400).send({ error: `"${d.band}" is not a band RFDeck knows for this family` });
      patch.band = profile.code; patch.bandSource = 'declared';
    }
    // Density mode is reported by the same families that report the band;
    // for the rest it is the operator's to say.
    if (typeof d.dense === 'boolean' && !bandIsReported(family)) patch.dense = d.dense;

    const updated = await prisma.inventoryDevice.update({ where: { id }, data: patch });
    const { password: _pw, ...rest } = updated;
    return { ...rest, hasPassword: !!_pw };
  });

  /** Push assignments to the hardware. Each line is reported on its own. */
  fastify.post('/coordination/apply', async (request, reply) => {
    const d = (request.body ?? {}) as any;
    if (!Array.isArray(d.assignments) || d.assignments.length === 0) {
      return reply.code(400).send({ error: 'assignments[] is required' });
    }
    const items: Array<{ id: string; frequencyKHz: number }> = [];
    for (const a of d.assignments) {
      const kHz = Number(a?.frequencyKHz);
      if (typeof a?.id !== 'string' || !Number.isFinite(kHz) || kHz <= 0) {
        return reply.code(400).send({ error: 'each assignment needs an id and a frequencyKHz' });
      }
      items.push({ id: a.id, frequencyKHz: Math.round(kHz) });
    }
    const manager = dm();
    if (!manager) return reply.code(503).send({ error: 'Device manager is not running' });
    const results = await manager.applyFrequencyPlan(items);
    return { results, sent: results.filter((r: any) => r.ok).length, failed: results.filter((r: any) => !r.ok).length };
  });
};
