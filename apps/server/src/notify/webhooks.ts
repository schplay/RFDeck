import crypto from 'crypto';
import { prisma } from '../db';
import { log } from '../logger';
import { decryptSecret } from '../auth/secretBox';
import { passesThreshold } from './severity';

// Webhooks: an alert, POSTed as JSON to a URL the operator supplies.
//
// The honest primitive for getting an alert out of the browser. It reaches
// Slack, Teams, a home automation box or a pager gateway without RFDeck taking
// on an account or a bill, and anything more elaborate can be built on it.
//
// Delivery is best-effort and bounded: one attempt, a short timeout, and the
// result recorded against the webhook so that one that is failing is visible
// in Settings rather than silently not arriving. A retry queue would be the
// next thing to add; a webhook that says "failed, 502, an hour ago" is the
// first thing.

export interface OutboundAlert {
  id: string;
  timestamp: string;
  severity: string;
  type: string;
  message: string;
  detail?: string;
  channelId?: string;
  channelName?: string;
  deviceId?: string;
  deviceName?: string;
}

export const DELIVERY_TIMEOUT_MS = 5_000;

/**
 * The signature a receiver can check: HMAC-SHA256 over the exact body, hex,
 * prefixed like the common convention so existing verifiers recognise it.
 */
export function signBody(body: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** The JSON a webhook receives. Stable: receivers will be written against it. */
export function webhookBody(alert: OutboundAlert, event: 'alert' | 'test' = 'alert'): string {
  return JSON.stringify({
    event,
    sentAt: new Date().toISOString(),
    alert,
  });
}

interface DeliveryResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** POST one payload to one URL, and say what happened. Never throws. */
export async function deliver(url: string, body: string, secret: string | null): Promise<DeliveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'RFDeck-Webhook/1',
      'X-RFDeck-Event': 'alert',
    };
    if (secret) headers['X-RFDeck-Signature'] = signBody(body, secret);
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err: any) {
    const error = err?.name === 'AbortError'
      ? `No response within ${DELIVERY_TIMEOUT_MS / 1000}s`
      : (err?.cause?.code ?? err?.code ?? err?.message ?? 'request failed');
    return { ok: false, status: null, error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Record the outcome against the webhook so it can be seen. */
async function record(id: string, r: DeliveryResult): Promise<void> {
  await prisma.webhook.update({
    where: { id },
    data: {
      lastAt: new Date(),
      lastStatus: r.status,
      lastError: r.error,
      failures: r.ok ? 0 : { increment: 1 },
    },
  }).catch(() => { /* the webhook may have been deleted mid-flight */ });
}

/** Send an alert to every enabled webhook whose threshold it clears. */
export async function dispatchToWebhooks(alert: OutboundAlert): Promise<void> {
  const hooks = await prisma.webhook.findMany({ where: { enabled: true } }).catch(() => []);
  const due = hooks.filter(h => passesThreshold(alert.severity, h.minSeverity));
  if (due.length === 0) return;

  const body = webhookBody(alert);
  await Promise.all(due.map(async h => {
    const r = await deliver(h.url, body, decryptSecret(h.secret));
    if (!r.ok) {
      log.warn(`[notify] Webhook "${h.name}" failed: ${r.error}`);
    }
    await record(h.id, r);
  }));
}

/** Send a sample alert to one webhook, whatever its threshold, and report. */
export async function testWebhook(id: string): Promise<DeliveryResult & { found: boolean }> {
  const h = await prisma.webhook.findUnique({ where: { id } });
  if (!h) return { found: false, ok: false, status: null, error: 'No such webhook' };
  const sample: OutboundAlert = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    severity: 'CRITICAL',
    type: 'TEST',
    message: `Test from RFDeck — "${h.name}" is receiving alerts`,
    detail: 'Sent from Settings. A real alert carries the channel and device it concerns.',
  };
  const r = await deliver(h.url, webhookBody(sample, 'test'), decryptSecret(h.secret));
  await record(h.id, r);
  return { found: true, ...r };
}
