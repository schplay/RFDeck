import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { encryptSecret } from '../auth/secretBox';
import { normaliseThreshold } from '../notify/severity';
import { testWebhook } from '../notify/webhooks';
import { vapidKeys, testPush } from '../notify/push';

// Notification targets: webhooks and browser push subscriptions.
//
// Secrets go out as "set" or "not set", never as themselves — the same rule as
// device passwords. Everything else is returned, including the last delivery
// result, because a target that is failing has to be visible to be fixed.

function safeWebhook(h: any) {
  const { secret, ...rest } = h;
  return { ...rest, hasSecret: !!secret };
}

function validUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch { return null; }
}

export const notificationRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Webhooks ────────────────────────────────────────────────────────────

  fastify.get('/notifications/webhooks', async () => {
    const hooks = await prisma.webhook.findMany({ orderBy: { createdAt: 'asc' } });
    return hooks.map(safeWebhook);
  });

  fastify.post('/notifications/webhooks', async (request, reply) => {
    const d = (request.body ?? {}) as any;
    const url = validUrl(d.url);
    if (!url) return reply.code(400).send({ error: 'A valid http or https URL is required' });
    const name = String(d.name ?? '').trim() || new URL(url).host;
    const hook = await prisma.webhook.create({
      data: {
        name, url,
        secret: d.secret ? encryptSecret(String(d.secret)) : null,
        enabled: typeof d.enabled === 'boolean' ? d.enabled : true,
        minSeverity: normaliseThreshold(d.minSeverity),
      },
    });
    return safeWebhook(hook);
  });

  fastify.put('/notifications/webhooks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const d = (request.body ?? {}) as any;
    const existing = await prisma.webhook.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'No such webhook' });

    let url: string | undefined;
    if (d.url !== undefined) {
      const v = validUrl(d.url);
      if (!v) return reply.code(400).send({ error: 'A valid http or https URL is required' });
      url = v;
    }
    const hook = await prisma.webhook.update({
      where: { id },
      data: {
        name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : undefined,
        url,
        // Blank means "leave alone"; null means "clear". Same rule as the
        // device password, for the same reason: editing the name must not
        // wipe a secret.
        secret: d.secret === null ? null : (d.secret ? encryptSecret(String(d.secret)) : undefined),
        enabled: typeof d.enabled === 'boolean' ? d.enabled : undefined,
        minSeverity: d.minSeverity !== undefined ? normaliseThreshold(d.minSeverity) : undefined,
      },
    });
    return safeWebhook(hook);
  });

  fastify.delete('/notifications/webhooks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.webhook.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  // Send a sample now and say what came back. The only way to know a URL is
  // right is to hit it.
  fastify.post('/notifications/webhooks/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string };
    const r = await testWebhook(id);
    if (!r.found) return reply.code(404).send({ error: r.error });
    return { ok: r.ok, status: r.status, error: r.error };
  });

  // ── Browser push ────────────────────────────────────────────────────────

  fastify.get('/notifications/push/key', async () => {
    const { publicKey } = await vapidKeys();
    return { publicKey };
  });

  fastify.get('/notifications/push/subscriptions', async () => {
    const subs = await prisma.pushSubscription.findMany({ orderBy: { createdAt: 'asc' } });
    // The endpoint is a capability URL; nobody needs to read it.
    return subs.map(({ keys, endpoint, ...rest }) => ({ ...rest, endpointHost: new URL(endpoint).host }));
  });

  fastify.post('/notifications/push/subscribe', async (request, reply) => {
    const d = (request.body ?? {}) as any;
    const sub = d.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return reply.code(400).send({ error: 'A push subscription with endpoint and keys is required' });
    }
    if (!validUrl(sub.endpoint)) return reply.code(400).send({ error: 'Subscription endpoint is not a URL' });
    const row = await prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        endpoint: sub.endpoint,
        keys: JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }),
        minSeverity: normaliseThreshold(d.minSeverity),
        label: typeof d.label === 'string' ? d.label.slice(0, 120) : null,
      },
      update: {
        keys: JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }),
        minSeverity: d.minSeverity !== undefined ? normaliseThreshold(d.minSeverity) : undefined,
        label: typeof d.label === 'string' ? d.label.slice(0, 120) : undefined,
        lastError: null,
      },
    });
    const { keys, endpoint, ...rest } = row;
    return { ...rest, endpointHost: new URL(endpoint).host };
  });

  fastify.post('/notifications/push/unsubscribe', async (request, reply) => {
    const d = (request.body ?? {}) as any;
    if (typeof d.endpoint !== 'string') return reply.code(400).send({ error: 'endpoint is required' });
    await prisma.pushSubscription.deleteMany({ where: { endpoint: d.endpoint } });
    return reply.code(204).send();
  });

  fastify.delete('/notifications/push/subscriptions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.pushSubscription.delete({ where: { id } }).catch(() => null);
    return reply.code(204).send();
  });

  fastify.post('/notifications/push/subscriptions/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string };
    const r = await testPush(id);
    if (!r.found) return reply.code(404).send({ error: r.error });
    return { ok: !r.error, error: r.error };
  });
};
