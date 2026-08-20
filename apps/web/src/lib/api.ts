// Single entry point for REST calls, so PIN handling lives in one place.
//
// The server is open by default on a trusted show network. When an admin turns
// on the PIN, remote clients get a 401 with code PIN_REQUIRED; we surface that
// through `onPinRequired` so the UI can prompt, rather than each caller having
// to know about auth.

export const API_BASE = 'http://localhost:3000/api';

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
      'Content-Type': 'application/json',
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
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface AuthStatus {
  pinEnabled: boolean;
  isLocal: boolean;
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
