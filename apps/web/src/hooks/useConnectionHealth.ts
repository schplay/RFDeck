import { useEffect, useState } from 'react';
import { useSocket } from './useSocket';
import { useChannelStore } from '../stores/channelStore';

// How long without an update before a channel's readings are considered stale.
// Telemetry arrives several times a second, so a few seconds of silence already
// means something is wrong.
const STALE_AFTER_MS = 6_000;

// During a show, telemetry that has silently frozen is more dangerous than an
// obvious outage: the numbers still look plausible, so nobody investigates.
// This tracks per-channel freshness and overall socket health so views can make
// "frozen" and "live" visually distinct.
export function useConnectionHealth() {
  const { isConnected } = useSocket();
  const channels = useChannelStore(s => s.channels);
  const [now, setNow] = useState(() => Date.now());

  // Freshness is a function of elapsed time, not of incoming data, so it needs
  // its own tick — otherwise a channel that stops updating never re-renders and
  // would never be marked stale.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(id);
  }, []);

  const lastUpdate = useChannelStore(s => s.lastUpdate);

  const isChannelStale = (channelId: string): boolean => {
    if (!isConnected) return true;
    const seen = lastUpdate[channelId];
    if (seen === undefined) return false; // never had data; not "stale"
    return now - seen > STALE_AFTER_MS;
  };

  const staleCount = channels.filter(ch => isChannelStale(ch.id)).length;

  return { isConnected, isChannelStale, staleCount, staleAfterMs: STALE_AFTER_MS };
}
