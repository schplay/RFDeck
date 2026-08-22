import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';

// AES67 senders on the network and which of them this server is receiving.
//
// The subscription state lives on the server, not here: every client sees the
// same routing, because it is a property of the rack rather than of whoever
// happens to be looking at it.

export interface AES67Source {
  id: string;
  name: string;
  via: string;
  address: string | null;
  /** Null when the SDP did not say — the server refuses to guess. */
  channels: number | null;
  subscribed: boolean;
  sinkId: number | null;
  /** 1-based inputs this sender lands on, matching the audio patch. */
  inputChannels: number[];
}

export interface AES67Status {
  available: boolean;
  reason: string | null;
  device: { id: string; label: string; channels: number } | null;
  sources: AES67Source[];
  ptp: { status?: string; gmid?: string } | null;
}

export function useAES67() {
  const [status, setStatus] = useState<AES67Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await apiFetch<AES67Status>('/aes67/status'));
    } catch (err: any) {
      setError(err?.message ?? 'Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const subscribe = useCallback(async (sourceId: string) => {
    setBusy(sourceId);
    setError(null);
    try {
      await apiFetch('/aes67/subscribe', {
        method: 'POST',
        body: JSON.stringify({ sourceId }),
      });
      await load();
    } catch (err: any) {
      setError(err?.message ?? 'Could not subscribe to that sender.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  const unsubscribe = useCallback(async (sinkId: number) => {
    setBusy(String(sinkId));
    setError(null);
    try {
      await apiFetch(`/aes67/subscribe/${sinkId}`, { method: 'DELETE' });
      await load();
    } catch (err: any) {
      setError(err?.message ?? 'Could not remove that subscription.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  const subscribeAll = useCallback(async () => {
    setBusy('all');
    setError(null);
    try {
      const result = await apiFetch<{ failed: Array<{ name: string; error: string }> }>(
        '/aes67/subscribe-all', { method: 'POST' },
      );
      // Partial success is the common case — report what did not work rather
      // than letting it look like everything succeeded.
      if (result.failed?.length) {
        setError(result.failed.map(f => `${f.name}: ${f.error}`).join(' · '));
      }
      await load();
    } catch (err: any) {
      setError(err?.message ?? 'Could not subscribe.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  return { status, loading, busy, error, reload: load, subscribe, unsubscribe, subscribeAll };
}
