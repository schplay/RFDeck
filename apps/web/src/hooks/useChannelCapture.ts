import { useState } from 'react';
import { Channel } from '@rfdeck/shared-types';
import { apiFetch } from '../lib/api';
import { useStatusStore } from '../stores/statusStore';

// Capture on request, for one channel, from wherever it is asked for.
//
// Shared between the channel card and the context menu so there is one way
// to start a capture and one way to stop it. The running state is the
// server's, not this hook's: a capture started at FOH is running backstage
// too, and both places see the same Stop.

export function useChannelCapture(channel: Channel) {
  const capture = useStatusStore(s => s.captures.find(c => c.channelKey === channel.id) ?? null);
  const [error, setError] = useState<string | null>(null);

  const start = async (minutes: number) => {
    setError(null);
    try {
      await apiFetch('/recording/capture', {
        method: 'POST',
        body: JSON.stringify({ channelKey: channel.id, minutes, channelName: channel.name }),
      });
    } catch (err: any) {
      // The server says why — not patched, recording off — and that reason is
      // the whole point of the error, so it is kept rather than summarised.
      setError(err?.message ?? 'Could not start the capture');
    }
  };

  const stop = async () => {
    if (!capture) return;
    try {
      await apiFetch(`/recording/capture/${capture.detectionId}/stop`, { method: 'POST' });
    } catch (err: any) {
      setError(err?.message ?? 'Could not stop the capture');
    }
  };

  return { capture, error, clearError: () => setError(null), start, stop };
}
