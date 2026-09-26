import { FastifyPluginAsync } from 'fastify';
import { CloudService } from '../cloud/service';

/**
 * The cloud link, for the Settings → Cloud page.
 *
 * Nothing here is show-critical: every route answers usefully when the cloud is
 * unconfigured, unlinked or unreachable, because that is the normal state of a
 * rig on a show LAN.
 */
export const cloudRoutes: FastifyPluginAsync = async (fastify) => {
  const service = () => (fastify as any).cloud as CloudService | undefined;

  fastify.get('/cloud/status', async () => {
    const cloud = service();
    if (!cloud) {
      return {
        configured: false, linked: false, accountId: null, linkedAt: null,
        lastRefreshAt: null, features: [], expiresAt: null, offline: false,
        needsRelink: null, browserClientId: null, baseUrl: null,
      };
    }
    return cloud.status();
  });

  /**
   * Begin the device flow.
   *
   * Returns the user code and the verification URI for the operator to open on
   * whatever device is to hand. The server polls in the background; the page
   * watches `/cloud/link` or the `cloud:status` socket event.
   */
  fastify.post('/cloud/link', async (request, reply) => {
    const cloud = service();
    if (!cloud?.configured) {
      return reply.code(409).send({
        error: 'not_configured',
        message: 'Meros Cloud is not configured on this server.',
      });
    }
    try {
      const pending = await cloud.startLink();
      return {
        userCode: pending.userCode,
        verificationUri: pending.verificationUri,
        verificationUriComplete: pending.verificationUriComplete,
        expiresAt: new Date(pending.expiresAt).toISOString(),
        outcome: pending.outcome,
      };
    } catch (err: any) {
      // Could not even start: almost always no route to the internet from the
      // rack, which is worth saying plainly rather than as a stack trace.
      return reply.code(502).send({
        error: 'link_start_failed',
        message: err?.message ?? 'Could not reach Meros to start linking.',
      });
    }
  });

  /** Where the pending link got to. */
  fastify.get('/cloud/link', async () => {
    const cloud = service();
    const pending = cloud?.linkProgress();
    if (!pending) return { pending: false };
    // A link that has just completed has to pick up the account and its
    // entitlements before the UI reads status, or the page shows "linked" with
    // nothing behind it.
    if (pending.outcome === 'linked') await cloud!.afterLink();
    return {
      pending: pending.outcome === 'pending',
      outcome: pending.outcome,
      detail: pending.detail,
      userCode: pending.userCode,
      verificationUri: pending.verificationUri,
      verificationUriComplete: pending.verificationUriComplete,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  });

  fastify.delete('/cloud/link', async () => {
    service()?.cancelLink();
    return { cancelled: true };
  });

  fastify.post('/cloud/unlink', async () => {
    const cloud = service();
    if (!cloud) return { revoked: false };
    return cloud.unlink();
  });

  // ── Show files ────────────────────────────────────────────────────────────
  //
  // Explicit and named. An operator moving between venues wants "get my show
  // from last week", not merge semantics on a live rig, so every one of these is
  // something they asked for.

  /** What is in the cloud, annotated with what this machine already has. */
  fastify.get('/cloud/showfiles', async (request, reply) => {
    const cloud = service();
    if (!cloud?.showFiles) return reply.code(409).send({ error: 'not_configured', shows: [] });
    try {
      return { shows: await cloud.showFiles.list() };
    } catch (err: any) {
      return reply.code(502).send({ error: 'unavailable', message: err?.message, shows: [] });
    }
  });

  /**
   * Save a show to the cloud.
   *
   * Three outcomes, all of which the UI needs to tell apart: pushed, already
   * current (the cloud has a byte-identical copy, so nothing to do and nothing to
   * ask), or a conflict that only the operator can settle.
   */
  fastify.post('/cloud/showfiles/:showId', async (request, reply) => {
    const { showId } = request.params as { showId: string };
    const cloud = service();
    if (!cloud?.showFiles) {
      return reply.code(409).send({ error: 'not_configured' });
    }
    try {
      const result = await cloud.showFiles.push(showId);
      if (result.status === 'conflict') {
        // 409 rather than 200: this is a refusal, and the body carries what the
        // operator needs in order to choose.
        return reply.code(409).send({
          error: 'version_conflict',
          message: result.conflict.message,
          head: {
            version: result.conflict.headVersion,
            updatedAt: result.conflict.headUpdatedAt,
          },
        });
      }
      return result;
    } catch (err: any) {
      return reply.code(502).send({ error: 'push_failed', message: err?.message });
    }
  });

  /**
   * Open a show from the cloud, overwriting the local copy.
   *
   * Destructive by design — it is the answer to "I want the cloud's version" —
   * so the confirmation belongs in the UI, which knows whether there are local
   * changes to lose.
   */
  fastify.post('/cloud/showfiles/:showId/pull', async (request, reply) => {
    const { showId } = request.params as { showId: string };
    const { version } = (request.body ?? {}) as { version?: number };
    const cloud = service();
    if (!cloud?.showFiles) return reply.code(409).send({ error: 'not_configured' });
    try {
      const result = await cloud.showFiles.pull(showId, version);
      // Every open client is showing this show's cast; tell them it changed.
      (fastify as any).io?.emit('shows:updated');
      return result;
    } catch (err: any) {
      return reply.code(502).send({ error: 'pull_failed', message: err?.message });
    }
  });

  /**
   * The venue's location, for the regional TV-occupancy exclusion source.
   *
   * Stored locally and never sent: the point-in-polygon test runs here against
   * cached cells, so the venue's position stays in the venue. That is a property
   * worth preserving deliberately rather than by accident.
   */
  fastify.put('/cloud/venue-location', async (request) => {
    const { venueLocation } = request.body as { venueLocation: string | null };
    const settings = await (fastify as any).prisma.settings.findFirst()
      ?? await (fastify as any).prisma.settings.create({ data: {} });
    const updated = await (fastify as any).prisma.settings.update({
      where: { id: settings.id },
      data: { venueLocation: venueLocation?.trim() || null },
    });
    return { venueLocation: updated.venueLocation };
  });
};
