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
