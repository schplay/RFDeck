import { useCallback, useEffect, useState } from 'react';
import type { MaintenanceEntry, MaintenanceKind } from '@rfdeck/shared-types';
import { apiFetch } from '../lib/api';
import { useSocket } from './useSocket';

// The maintenance log for one device.
//
// Scoped to a device rather than held in a global store: it is read in the
// device drawer and nowhere else, and a fleet's worth of history is not worth
// keeping in memory to answer a question about one receiver.
//
// Server-authoritative like the rest — a note written backstage is there at
// FOH, so socket events refetch rather than each client keeping its own idea.

export function useMaintenance(deviceId: string | null) {
  const { socket } = useSocket();
  const [entries, setEntries] = useState<MaintenanceEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!deviceId) { setEntries([]); return; }
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ entries: MaintenanceEntry[] }>(
        `/inventory/${deviceId}/maintenance`,
      );
      setEntries(data.entries);
    } catch {
      setError('Could not load the maintenance log.');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!socket || !deviceId) return;
    const onChanged = (p: { deviceId: string }) => {
      if (p?.deviceId === deviceId) load();
    };
    socket.on('maintenance:changed', onChanged);
    return () => { socket.off('maintenance:changed', onChanged); };
  }, [socket, deviceId, load]);

  const add = useCallback(async (entry: {
    kind: MaintenanceKind; summary: string; detail?: string; at?: string;
  }) => {
    if (!deviceId) return;
    await apiFetch(`/inventory/${deviceId}/maintenance`, {
      method: 'POST',
      body: JSON.stringify(entry),
    });
    await load();
  }, [deviceId, load]);

  const update = useCallback(async (id: string, patch: Partial<{
    kind: MaintenanceKind; summary: string; detail: string; at: string;
  }>) => {
    if (!deviceId) return;
    await apiFetch(`/inventory/${deviceId}/maintenance/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    await load();
  }, [deviceId, load]);

  const remove = useCallback(async (id: string) => {
    if (!deviceId) return;
    await apiFetch(`/inventory/${deviceId}/maintenance/${id}`, { method: 'DELETE' });
    await load();
  }, [deviceId, load]);

  return { entries, loading, error, reload: load, add, update, remove };
}
