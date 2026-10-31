import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { CloudService } from '../cloud/service';
import { CloudOffline, CloudRefused } from '../cloud/merosClient';
import { PersonSignedOut } from '../cloud/people';
import { SignInError, safeReturnTo } from '../cloud/signIn';
import { isLoopback } from '../auth/pinAuth';
import { FEATURES } from '../cloud/features';
import { prisma } from '../db';
import { listPerformers } from '../performers/roster';

/** Where meros.co sends a browser back to after signing in. */
const CALLBACK = '/api/cloud/signin/callback';
/** The cookie that binds a sign-in's callback to the browser that began it. */
const STATE_COOKIE = 'rfdeck_signin';

function stateCookie(state: string, maxAgeSec: number): string {
  return `${STATE_COOKIE}=${encodeURIComponent(state)}; Path=/api/cloud/signin; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

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
        needsRelink: null, peopleCanSignIn: false, baseUrl: null,
        eventsToCloud: false, eventsQueued: 0,
      };
    }
    return cloud.status();
  });

  // ── Signing in with Meros ─────────────────────────────────────────────────
  //
  // The instance (linking this RFDeck to an account) and people (syncing their
  // preferences) sign in the same way: meros.co's sign-in page in a browser.
  // See cloud/signIn.ts for the two ways there, loopback and redirect.

  const sendSignInError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SignInError) return reply.code(err.status).send({ error: err.code, message: err.message });
    throw err;
  };

  /**
   * Sign in. From RFDeck Desktop on its own computer this waits, up to five
   * minutes, for the sign-in in the system browser and answers when it's done.
   * From any other browser it answers `{redirect}`, the meros.co page to send
   * the browser to, and sets the cookie the callback checks.
   */
  fastify.post('/cloud/signin', async (request, reply) => {
    const cloud = service();
    if (!cloud?.signIn) {
      return reply.code(409).send({ error: 'not_configured', message: 'Meros Cloud is not configured on this server.' });
    }
    const body = (request.body ?? {}) as { purpose?: string; returnTo?: string; remember?: boolean };
    if (body.purpose !== 'instance' && body.purpose !== 'person') {
      return reply.code(400).send({ error: 'invalid_request', message: 'purpose must be "instance" or "person".' });
    }
    const persistent = body.remember === true;
    try {
      if (cloud.signIn.usesLoopback(isLoopback(request.ip))) {
        const person = await cloud.signIn.signInHere(body.purpose, persistent);
        if (!person) {
          await cloud.afterLink();
          return { signedIn: true, purpose: 'instance' };
        }
        return { signedIn: true, purpose: 'person', token: person.token, person: person.person };
      }
      const host = request.headers.host;
      if (!host) return reply.code(400).send({ error: 'invalid_request', message: 'The request has no Host.' });
      const { authorizeUrl, state } = await cloud.signIn.begin(
        body.purpose, `https://${host}${CALLBACK}`, safeReturnTo(body.returnTo), persistent,
      );
      reply.header('set-cookie', stateCookie(state, 600));
      return { redirect: authorizeUrl };
    } catch (err) {
      return sendSignInError(reply, err);
    }
  });

  /**
   * RFDeck Desktop's sign-in in the system browser, while it waits: the page it
   * opened, for an operator whose browser didn't come up.
   */
  fastify.get('/cloud/signin', async () => {
    return { pending: service()?.signIn?.pendingLoopback ?? null };
  });

  /** Stop RFDeck Desktop's sign-in in the system browser. */
  fastify.post('/cloud/signin/cancel', async () => {
    return { canceled: service()?.signIn?.cancel() ?? false };
  });

  /**
   * meros.co sends the browser back here. Open past the PIN (it's a
   * navigation), and bound to the browser that began the sign-in by the state
   * cookie. Sends the browser on to the page it began from, with the outcome.
   */
  fastify.get(CALLBACK.replace('/api', ''), async (request, reply) => {
    const cloud = service();
    const query = request.query as Record<string, string | undefined>;
    const params = new URLSearchParams();
    let returnTo = '#/';
    reply.header('set-cookie', stateCookie('', 0));
    if (!cloud?.signIn) {
      params.set('signin_error', 'not_configured');
    } else {
      try {
        const finished = await cloud.signIn.finish(query, readCookie(request.headers.cookie, STATE_COOKIE));
        returnTo = finished.returnTo;
        if (finished.purpose === 'instance') {
          await cloud.afterLink();
          params.set('signin', 'linked');
        } else {
          params.set('signin', 'person');
          params.set('claim', finished.claim!);
        }
      } catch (err) {
        if (!(err instanceof SignInError)) throw err;
        const begun = err as SignInError & { returnTo?: string; purpose?: string };
        returnTo = safeReturnTo(begun.returnTo);
        params.set('signin_error', err.code);
        if (begun.purpose) params.set('signin_for', begun.purpose);
      }
    }
    // Never cached: the address carries a single-use claim code.
    reply.header('cache-control', 'no-store');
    return reply.redirect(`/?${params}${returnTo}`);
  });

  // ── The person signed in in this browser ──────────────────────────────────

  const person = async (request: FastifyRequest) => {
    const header = request.headers['x-rfdeck-person'];
    return (await service()?.people?.resolve(typeof header === 'string' ? header : undefined)) ?? null;
  };

  const notSignedIn = (reply: FastifyReply) =>
    reply.code(401).send({ error: 'person_signed_out', message: 'Sign in with Meros to sync preferences.' });

  const sendPersonError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof PersonSignedOut) return reply.code(401).send({ error: 'person_signed_out', message: err.message });
    if (err instanceof CloudOffline) return reply.code(502).send({ error: 'meros_unreachable', message: err.message });
    if (err instanceof CloudRefused) {
      if (err.status === 413) {
        return reply.code(413).send({
          error: 'profile_too_large',
          message: 'Your saved preferences are too large to sync. Something is storing more than it should be.',
        });
      }
      return reply.code(502).send({ error: err.code ?? 'meros_refused', message: err.message });
    }
    throw err;
  };

  /** Exchange the code the sign-in came back with for this browser's token, once. */
  fastify.post('/cloud/me/claim', async (request, reply) => {
    const code = (request.body as { code?: unknown } | undefined)?.code;
    const people = service()?.people;
    const claimed = people && typeof code === 'string' ? await people.claim(code) : null;
    if (!claimed) {
      return reply.code(400).send({ error: 'unknown_request', message: 'This sign-in expired or was already used. Sign in again.' });
    }
    return { token: claimed.token, person: claimed.person };
  });

  fastify.get('/cloud/me', async (request, reply) => {
    const who = await person(request);
    return who ? { person: who } : notSignedIn(reply);
  });

  fastify.get('/cloud/me/profile', async (request, reply) => {
    const who = await person(request);
    if (!who) return notSignedIn(reply);
    try {
      return await service()!.people!.profile(who);
    } catch (err) {
      return sendPersonError(reply, err);
    }
  });

  /** Merge these keys into the person's preferences; a null value removes one. */
  fastify.put('/cloud/me/profile', async (request, reply) => {
    const who = await person(request);
    if (!who) return notSignedIn(reply);
    const keys = (request.body as { keys?: unknown } | undefined)?.keys;
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
      return reply.code(400).send({ error: 'invalid_request', message: 'keys must be an object.' });
    }
    try {
      return await service()!.people!.putProfile(who, keys as Record<string, unknown>);
    } catch (err) {
      return sendPersonError(reply, err);
    }
  });

  /** Sign the person out, here and at Meros, in every browser signed in as them. */
  fastify.post('/cloud/me/signout', async (request) => {
    const who = await person(request);
    if (who) await service()!.people!.signOut(who);
    return { signedIn: false };
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
    const refusal = await denied(cloud, FEATURES.BACKUP_SHOWFILE);
    if (refusal) return reply.code(402).send({ ...refusal, shows: [] });
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
    const refusal = await denied(cloud, FEATURES.BACKUP_SHOWFILE);
    if (refusal) return reply.code(402).send(refusal);
    try {
      const result = await cloud.showFiles.push(showId);
      if (result.status === 'conflict') {
        // 409 rather than 200: this is a refusal, and the body carries what the
        // operator needs in order to choose.
        return reply.code(409).send({
          error: 'version_conflict',
          message: result.conflict.message,
          head: { version: result.conflict.headVersion },
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
    const refusal = await denied(cloud, FEATURES.BACKUP_SHOWFILE);
    if (refusal) return reply.code(402).send(refusal);
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
  // *this* rig on replacement hardware. One document, `config/app`, so a
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
          head: { version: result.conflict.headVersion },
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
        // The restored battery levels drive alerts and every client's colors.
        await dm.applyBatteryThresholds().catch(() => {});
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
   * Off by default. With it off nothing is gathered or sent, which is what makes
   * an unconfigured install indistinguishable from one without the feature.
   */
  fastify.put('/cloud/events', async (request, reply) => {
    const { enabled } = request.body as { enabled: boolean };
    const cloud = service();
    if (!cloud?.configured) return reply.code(409).send({ error: 'not_configured' });
    await cloud.setEventsToCloud(!!enabled);
    return { enabled: !!enabled };
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
