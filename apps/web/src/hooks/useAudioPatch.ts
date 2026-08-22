import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useSocket } from './useSocket';

// The audio patch: which input of which interface each RF channel is wired to.
//
// Held on the server because it describes the rack, not a viewer's preference —
// every client sees the same wiring. Driven entirely by what the server reports,
// so any number of interfaces with any number of inputs each are handled without
// assuming a particular rig.

export interface ServerAudioDevice {
  id: string;
  label: string;
  channels: number;
  /** False when the server could not read the width and is assuming one. */
  channelsProbed: boolean;
}

export interface Assignment {
  channelKey: string;
  deviceId: string;
  inputChannel: number;
}

export function useAudioPatch() {
  const { socket } = useSocket();
  const [devices, setDevices] = useState<ServerAudioDevice[]>([]);
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({});
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (rescan = false) => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{
        devices: ServerAudioDevice[];
        assignments: Assignment[];
        hint: string | null;
      }>(`/audio/devices${rescan ? '?rescan=1' : ''}`);
      setDevices(data.devices);
      setHint(data.hint);
      setAssignments(Object.fromEntries(data.assignments.map(a => [a.channelKey, a])));
    } catch {
      setError('Could not reach the server to list audio devices.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Another client changing the patch should be reflected here — the wiring is
  // shared, so two operators must not see different answers.
  useEffect(() => {
    if (!socket) return;
    const onChanged = () => load();
    socket.on('audio:assignments-changed', onChanged);
    return () => { socket.off('audio:assignments-changed', onChanged); };
  }, [socket, load]);

  const patch = useCallback(async (
    channelKey: string,
    deviceId: string | null,
    inputChannel: number | null,
  ) => {
    // Optimistic so the control responds immediately; reverted on failure.
    const previous = assignments[channelKey];
    setAssignments(a => {
      const next = { ...a };
      if (deviceId && inputChannel) next[channelKey] = { channelKey, deviceId, inputChannel };
      else delete next[channelKey];
      return next;
    });

    try {
      await apiFetch(`/audio/assignments/${encodeURIComponent(channelKey)}`, {
        method: 'PUT',
        body: JSON.stringify({ deviceId, inputChannel }),
      });
      setError(null);
    } catch (err: any) {
      setAssignments(a => {
        const next = { ...a };
        if (previous) next[channelKey] = previous; else delete next[channelKey];
        return next;
      });
      setError(err?.message ?? 'Could not save that patch.');
    }
  }, [assignments]);

  return { devices, assignments, hint, loading, error, patch, reload: load };
}
