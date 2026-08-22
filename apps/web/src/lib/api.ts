// Single entry point for REST calls, so PIN handling lives in one place.
//
// The server is open by default on a trusted show network. When an admin turns
// on the PIN, remote clients get a 401 with code PIN_REQUIRED; we surface that
// through `onPinRequired` so the UI can prompt, rather than each caller having
// to know about auth.

// Where the RFDeck server lives, from this client's point of view.
//
// This must NOT be hardcoded to localhost: a browser on another machine would
// then query its own machine and find nothing, which breaks every remote client
// — the normal case for a headless deployment.
//
// Three situations to tell apart:
//   • Served by the RFDeck server  → same origin, whatever host that is
//   • Vite dev server (port 5173)  → UI and API are on different ports
//   • Electron (file:// URL)       → no useful origin; the server is local
export function serverOrigin(): string {
  if (typeof window === 'undefined') return 'http://localhost:3000';

  const { protocol, port, origin } = window.location;

  if (protocol === 'file:') return 'http://localhost:3000';
  if (port === '5173' || port === '4173') return 'http://localhost:3000';

  return origin;
}

export const API_BASE = `${serverOrigin()}/api`;

const TOKEN_KEY = 'rfdeck-auth-token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Set by the auth provider at startup. Called whenever the server rejects us,
// including when a token expires mid-session because the admin set a re-auth
// interval.
let onPinRequired: (() => void) | null = null;
export function setPinRequiredHandler(fn: (() => void) | null): void {
  onPinRequired = fn;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      // Only claim a JSON body when there is one. Fastify rejects an empty body
      // under this content type with 400 "Bad Request", which silently broke
      // every bodyless POST and DELETE routed through here — revoke-all, clear
      // alerts, delete show, unsubscribe — while calls that send a body worked.
      ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'x-rfdeck-token': token } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    if (body?.code === 'PIN_REQUIRED') {
      setToken(null);
      onPinRequired?.();
    }
    throw new ApiError(body?.error ?? 'Authentication required', 401, body?.code);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // RFDeck's own routes put the explanation in `error`. Fastify's built-in
    // errors put a generic label there ("Bad Request") and the actual reason in
    // `message` — surface the specific one, or the label reads as the whole story.
    throw new ApiError(
      body?.message ?? body?.error ?? `Request failed (${res.status})`,
      res.status,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface AuthStatus {
  pinEnabled: boolean;
  isLocal: boolean;
  /** Whether THIS client is permitted to change access settings. */
  canConfigure: boolean;
  reauthHours: number;
  authenticated: boolean;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const token = getToken();
  const res = await fetch(`${API_BASE}/auth/status`, {
    headers: token ? { 'x-rfdeck-token': token } : {},
  });
  if (!res.ok) throw new ApiError('Could not reach the server', res.status);
  return res.json();
}

export async function submitPin(pin: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) return false;
  const body = await res.json();
  setToken(body.token ?? null);
  return true;
}
