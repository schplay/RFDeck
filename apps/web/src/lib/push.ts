import { apiFetch } from './api';

// Browser push, from the page's side: register the worker, ask permission,
// subscribe, and tell the server.
//
// Each step can be unavailable for a reason the operator should be told —
// not HTTPS, a browser without push, permission denied, the desktop app's
// file:// origin — so the status is a sentence, not a boolean.

export type PushStatus =
  | { state: 'unsupported'; reason: string }
  | { state: 'denied' }
  | { state: 'off' }
  | { state: 'on'; endpoint: string };

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  // Over an explicit ArrayBuffer: applicationServerKey wants a BufferSource,
  // and a view over a possibly-shared buffer is not one.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function unsupportedReason(): string | null {
  if (typeof window === 'undefined') return 'No window';
  if (window.location.protocol === 'file:') {
    return 'Push is not available in the desktop app; use a browser pointed at the server.';
  }
  if (!('serviceWorker' in navigator)) return 'This browser has no service worker support.';
  if (!('PushManager' in window)) return 'This browser has no push support.';
  if (!window.isSecureContext) return 'Push needs HTTPS (or localhost).';
  return null;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // Relative, so it works under the './' base the app is built with and lands
  // in the same scope as the page.
  return navigator.serviceWorker.register('./sw.js');
}

export async function pushStatus(): Promise<PushStatus> {
  const why = unsupportedReason();
  if (why) return { state: 'unsupported', reason: why };
  if (Notification.permission === 'denied') return { state: 'denied' };
  try {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    return sub ? { state: 'on', endpoint: sub.endpoint } : { state: 'off' };
  } catch (err: any) {
    return { state: 'unsupported', reason: err?.message ?? 'Service worker registration failed' };
  }
}

export async function enablePush(minSeverity: string): Promise<PushStatus> {
  const why = unsupportedReason();
  if (why) return { state: 'unsupported', reason: why };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { state: 'denied' };

  const { publicKey } = await apiFetch<{ publicKey: string }>('/notifications/push/key');
  const reg = await registration();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await apiFetch('/notifications/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      subscription: sub.toJSON(),
      minSeverity,
      label: navigator.userAgent.slice(0, 120),
    }),
  });
  return { state: 'on', endpoint: sub.endpoint };
}

export async function disablePush(): Promise<PushStatus> {
  const why = unsupportedReason();
  if (why) return { state: 'unsupported', reason: why };
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await apiFetch('/notifications/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe();
  }
  return { state: 'off' };
}
