import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { normaliseThreshold } from '../notify/severity';
import { vapidKeys, testPush } from '../notify/push';

/** A push endpoint the browser handed us should still be a URL we can post to. */
function validUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch { return null; }
}

// Notification targets: browser push subscriptions.
//
// Push is the only alert channel the application itself owns — no account, no bill,
// no third party RFDeck operates on anyone's behalf. Webhook delivery used to live
// here too and is now Meros's, configured in the cloud over RFDeck's event stream.
//
// A target that is failing has to be visible to be fixed, so the last delivery
// result is returned along with everything else.

export const notificationRoutes: FastifyPluginAsync = async (fastify) => {
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
