import webpush from 'web-push';
import { prisma } from '../db';
import { log } from '../logger';
import { encryptSecret, decryptSecret } from '../auth/secretBox';
import { passesThreshold } from './severity';
import type { OutboundAlert } from './webhooks';

// Browser push: an alert on a phone through the browser's own push service.
//
// Free-tier, like webhooks: no account, no bill, no third party RFDeck
// operates on anyone's behalf. The browser hands RFDeck a subscription; RFDeck
// signs messages to it with a key pair that identifies this server.
//
// The key pair is generated once and kept. Every subscription is bound to the
// public key, so regenerating it would silently orphan every phone that had
// ever subscribed — and nobody would find out until the night nothing arrived.

const SUBJECT = 'mailto:rfdeck@localhost';

let keys: { publicKey: string; privateKey: string } | null = null;

/** The server's VAPID keys, generated and stored on first use. */
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (keys) return keys;
  let settings = await prisma.settings.findFirst();
  if (!settings) settings = await prisma.settings.create({ data: {} });

  const priv = decryptSecret(settings.vapidPrivateKey ?? null);
  if (settings.vapidPublicKey && priv) {
    keys = { publicKey: settings.vapidPublicKey, privateKey: priv };
  } else {
    const fresh = webpush.generateVAPIDKeys();
    await prisma.settings.update({
      where: { id: settings.id },
      data: { vapidPublicKey: fresh.publicKey, vapidPrivateKey: encryptSecret(fresh.privateKey) },
    });
    keys = fresh;
    log.info('[notify] Generated VAPID keys for browser push');
  }
  webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);
  return keys;
}

interface StoredSub {
  id: string;
  endpoint: string;
  keys: string;
  minSeverity: string;
}

async function sendTo(sub: StoredSub, payload: string): Promise<void> {
  try {
    const parsedKeys = JSON.parse(sub.keys) as { p256dh: string; auth: string };
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: parsedKeys }, payload, {
      TTL: 60 * 60,
      urgency: 'high',
    });
    await prisma.pushSubscription.update({
      where: { id: sub.id },
      data: { lastAt: new Date(), lastError: null },
    }).catch(() => {});
  } catch (err: any) {
    const status = err?.statusCode as number | undefined;
    // 404 and 410 are the push service saying this subscription is dead —
    // the browser unsubscribed, or the app was uninstalled. Keeping it would
    // mean failing to it forever.
    if (status === 404 || status === 410) {
      await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      log.info(`[notify] Push subscription ${sub.id} expired and was removed`);
      return;
    }
    const error = status ? `HTTP ${status}` : (err?.message ?? 'send failed');
    log.warn(`[notify] Push to ${sub.id} failed: ${error}`);
    await prisma.pushSubscription.update({
      where: { id: sub.id },
      data: { lastAt: new Date(), lastError: String(error) },
    }).catch(() => {});
  }
}

/** What the service worker receives and turns into a notification. */
export function pushPayload(alert: OutboundAlert): string {
  return JSON.stringify({
    title: alert.channelName
      ? `${alert.channelName}: ${alert.message}`
      : alert.deviceName
        ? `${alert.deviceName}: ${alert.message}`
        : alert.message,
    body: alert.detail ?? `${alert.severity} · ${alert.type}`,
    // Same tag per channel, so a flapping channel updates one notification
    // rather than stacking twenty.
    tag: alert.channelId ?? alert.deviceId ?? alert.type,
    severity: alert.severity,
    url: '/#/',
    sentAt: new Date().toISOString(),
  });
}

/** Send an alert to every subscription whose threshold it clears. */
export async function dispatchToPush(alert: OutboundAlert): Promise<void> {
  const subs = await prisma.pushSubscription.findMany().catch(() => [] as StoredSub[]);
  const due = subs.filter(s => passesThreshold(alert.severity, s.minSeverity));
  if (due.length === 0) return;
  await vapidKeys();
  const payload = pushPayload(alert);
  await Promise.all(due.map(s => sendTo(s, payload)));
}

/** Send a sample to one subscription, whatever its threshold. */
export async function testPush(id: string): Promise<{ found: boolean; error: string | null }> {
  const sub = await prisma.pushSubscription.findUnique({ where: { id } });
  if (!sub) return { found: false, error: 'No such subscription' };
  await vapidKeys();
  await sendTo(sub, pushPayload({
    id: 'test', timestamp: new Date().toISOString(), severity: 'CRITICAL', type: 'TEST',
    message: 'Test from RFDeck', detail: 'This browser is receiving alerts.',
  }));
  const after = await prisma.pushSubscription.findUnique({ where: { id } });
  return { found: true, error: after ? after.lastError : 'Subscription was rejected by the push service and removed' };
}
