import { FastifyPluginAsync } from 'fastify';
import { CloudService } from '../cloud/service';
import { FEATURES } from '../cloud/features';
import { prisma } from '../db';
import { listPerformers } from '../performers/roster';

/**
 * The cloud link, for the Settings → Cloud page.
 *
 * Nothing here is show-critical: every route answers usefully when the cloud is
 * unconfigured, unlinked or unreachable, because that is the normal state of a
 * rig on a show LAN.
 */
export const cloudRoutes: FastifyPluginAsync = async (fastify) => {
  const service = () => (fastify as any).cloud as CloudService | undefined;

  /**
   * The gate, phrased the way the UI phrases it.
   *
   * 402 rather than 403: this is "your account does not include this", not
   * "you may not". The message is what the operator reads, so it says which tier
   * and where to change it rather than naming a flag.
   */
  const denied = async (cloud: CloudService, feature: string) => {
    if (await cloud.entitled(feature)) return null;
    return {
      error: 'not_entitled',
      feature,
      message: 'Your Meros account does not currently include this. Check your subscription at meros.co.',
    };
  };

  fastify.get('/cloud/status', async () => {
    const cloud = service();
    if (!cloud) {
      return {
        configured: false, linked: false, accountId: null, linkedAt: null,
        lastRefreshAt: null, features: [], expiresAt: null, offline: false,
        needsRelink: null, browserClientId: null, baseUrl: null,
        eventsToCloud: false, eventsQueued: 0,
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

  // ── The install snapshot ──────────────────────────────────────────────────
  //
  // The other half of the split: a show file carries a production to another
  // venue and deliberately leaves the local rig alone, whereas this rebuilds
  // *this* rig on replacement hardware. One document, `config/instance`, so a
  // restore has one obvious thing to take.

  /** What this install would send, without sending it. */
  fastify.get('/cloud/config-backup/preview', async (request, reply) => {
    const cloud = service();
    if (!cloud?.configBackup) return reply.code(409).send({ error: 'not_configured' });
    const refusal = await denied(cloud, FEATURES.BACKUP_CONFIG);
    if (refusal) return reply.code(402).send(refusal);
    const local = await cloud.configBackup.build();
    return {
      local: {
        devices: local.devices.length,
        performers: local.performers.length,
        audioPatch: local.audioPatch.length,
      },
      cloud: await cloud.configBackup.preview(),
    };
  });

  /** Back this install up. */
  fastify.post('/cloud/config-backup', async (request, reply) => {
    const cloud = service();
    if (!cloud?.configBackup) return reply.code(409).send({ error: 'not_configured' });
    const refusal = await denied(cloud, FEATURES.BACKUP_CONFIG);
    if (refusal) return reply.code(402).send(refusal);
    try {
      const result = await cloud.configBackup.push();
      if (result.status === 'conflict') {
        // Another install backed up to this account. Which is very probably a
        // mistake — one document per account means the second machine would
        // overwrite the first — so it is a refusal with the head attached rather
        // than a silent last-writer-wins.
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
      return reply.code(502).send({ error: 'backup_failed', message: err?.message });
    }
  });

  /**
   * Restore this install from the cloud.
   *
   * Requires `confirm: true` in the body. A restore rewrites the inventory and
   * the roster, and the operator should have read `preview` first — a route that
   * did it on a bare POST would be one mistyped URL away from rewriting a rig
   * mid-show.
   */
  fastify.post('/cloud/config-backup/restore', async (request, reply) => {
    const { confirm } = (request.body ?? {}) as { confirm?: boolean };
    const cloud = service();
    if (!cloud?.configBackup) return reply.code(409).send({ error: 'not_configured' });
    const refusal = await denied(cloud, FEATURES.BACKUP_CONFIG);
    if (refusal) return reply.code(402).send(refusal);
    if (confirm !== true) {
      return reply.code(400).send({
        error: 'confirmation_required',
        message: "A restore rewrites this install's inventory and settings, so it must be confirmed.",
      });
    }
    try {
      const result = await cloud.configBackup.restore();

      // The rig itself changed, not just the screen. Devices that came back have
      // to be picked up by the poller or a restored inventory would sit there
      // showing everything offline until the next restart.
      const dm = (fastify as any).deviceManager;
      if (dm) {
        for (const device of await prisma.inventoryDevice.findMany()) {
          try { dm.updateTrackedDevice(device); } catch { /* one bad row must not stop the rest */ }
        }
      }

      // Then tell every open client, with the roster inline because that is the
      // contract for this event — clients replace their whole list from it.
      const io = (fastify as any).io;
      io?.emit('inventory:updated');
      io?.emit('performers:updated', await listPerformers());
      return result;
    } catch (err: any) {
      return reply.code(502).send({ error: 'restore_failed', message: err?.message });
    }
  });

  // ── The online inventory listing ──────────────────────────────────────────
  //
  // A mirror of this install's inventory in the operator's account, so they can
  // look up what they own without being at the rack. Paid, and account-private.

  /** What the cloud lists, and what this install would send. */
  fastify.get('/cloud/inventory', async (request, reply) => {
    const cloud = service();
    if (!cloud?.inventory) return reply.code(409).send({ error: 'not_configured' });
    const refusal = await denied(cloud, FEATURES.INVENTORY);
    if (refusal) return reply.code(402).send(refusal);
    try {
      const [local, remote] = await Promise.all([
        cloud.inventory.build(),
        // A listing that has never been pushed is an ordinary answer, not a fault.
        cloud.inventory.fetch().catch((err) => ({ error: err.message })),
      ]);
      return {
        local: { count: local.length },
        cloud: 'error' in remote
          ? { available: false, reason: remote.error, count: 0, updatedAt: null }
          : { available: true, reason: null, count: remote.count, updatedAt: remote.updated_at },
      };
    } catch (err: any) {
      return reply.code(502).send({ error: 'unavailable', message: err?.message });
    }
  });

  /**
   * Publish this install's inventory.
   *
   * A reconcile: the cloud drops anything absent from what is sent. Deliberately an
   * operator action rather than a background sync, because two rigs pushing to one
   * account would each erase the other's devices and neither would be wrong to.
   */
  fastify.post('/cloud/inventory', async (request, reply) => {
    const cloud = service();
    if (!cloud?.inventory) return reply.code(409).send({ error: 'not_configured' });
    const refusal = await denied(cloud, FEATURES.INVENTORY);
    if (refusal) return reply.code(402).send(refusal);
    try {
      return await cloud.inventory.push();
    } catch (err: any) {
      return reply.code(502).send({ error: 'push_failed', message: err?.message });
    }
  });

  /** Remove the listing from the account, without touching the local inventory. */
  fastify.delete('/cloud/inventory', async (request, reply) => {
    const cloud = service();
    if (!cloud?.inventory) return reply.code(409).send({ error: 'not_configured' });
    const refusal = await denied(cloud, FEATURES.INVENTORY);
    if (refusal) return reply.code(402).send(refusal);
    try {
      await cloud.inventory.clear();
      return { cleared: true };
    } catch (err: any) {
      return reply.code(502).send({ error: 'clear_failed', message: err?.message });
    }
  });

  /**
   * Send events to the cloud, or stop.
   *
   * Off by default. With it off there are no collectors at all, which is what
   * makes an unconfigured install indistinguishable from one without the feature.
   */
  fastify.put('/cloud/events', async (request, reply) => {
    const { enabled } = request.body as { enabled: boolean };
    const cloud = service();
    if (!cloud?.configured) return reply.code(409).send({ error: 'not_configured' });
    await cloud.setEventsToCloud(!!enabled);
    return { enabled: !!enabled, collectors: cloud.events?.collectorCount ?? 0 };
  });

  /**
   * What TV occupancy RFDeck can work out here, and from how stale a pack.
   *
   * Answered from cache only, so it is safe to call at show time and it tells the
   * truth about being offline rather than hiding it.
   */
  fastify.get('/cloud/tv-occupancy', async () => {
    const cloud = service();
    if (!cloud) {
      return {
        exclusions: null, unmapped: [], source: 'none', oldestFetchedAt: null,
        cellsUsed: [], reason: 'Meros Cloud is not configured on this server.',
      };
    }
    return cloud.occupancy();
  });

  /** Fetch the venue's cells now, rather than waiting for the daily refresh. */
  fastify.post('/cloud/tv-occupancy/refresh', async (request, reply) => {
    const cloud = service();
    if (!cloud?.regional) return reply.code(409).send({ error: 'not_configured' });
    await cloud.refreshRegional();
    return cloud.occupancy();
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
    // A new location means different cells. Fetch them now rather than leaving
    // the operator with a location set and no data until tomorrow.
    void (fastify as any).cloud?.refreshRegional?.();
    return { venueLocation: updated.venueLocation };
  });
};
