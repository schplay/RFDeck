import { useEffect, useState } from 'react';
import { useSocket } from './useSocket';
import { useChannelStore } from '../stores/channelStore';

// How long without contact before a channel's readings are considered stale.
//
// "Contact" is the server's heartbeat for the channel's device, not telemetry
// arrival. Telemetry is pushed only when a value changes, so a receiver whose
// mic is on but nobody is speaking into sends nothing for minutes at a time —
// and that silence is the normal state of a live show, not a fault. The server
// probes a quiet device every few seconds and reports every two, so ten seconds
// of no contact genuinely means something is wrong.
const STALE_AFTER_MS = 10_000;

// During a show, telemetry that has silently frozen is more dangerous than an
// obvious outage: the numbers still look plausible, so nobody investigates.
// This tracks per-device contact and overall socket health so views can make
// "frozen" and "live" visually distinct.
export function useConnectionHealth() {
  const { isConnected } = useSocket();
  const channels = useChannelStore(s => s.channels);
  const deviceSeen = useChannelStore(s => s.deviceSeen);
  const heartbeatAt = useChannelStore(s => s.heartbeatAt);
  const lastUpdate = useChannelStore(s => s.lastUpdate);
  const [now, setNow] = useState(() => Date.now());

  // Freshness is a function of elapsed time, not of incoming data, so it needs
  // its own tick — otherwise a channel that stops updating never re-renders and
  // would never be marked stale.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(id);
  }, []);

  const isChannelStale = (channelId: string): boolean => {
    if (!isConnected) return true;

    const channel = channels.find(c => c.id === channelId);
    const seen = channel ? deviceSeen[channel.deviceId] : undefined;

    if (seen !== undefined) {
      // Heartbeats arrive every two seconds. If they have stopped, it is the
      // server's view that has frozen, and every channel is suspect.
      if (heartbeatAt !== null && now - heartbeatAt > STALE_AFTER_MS) return true;
      return now - seen > STALE_AFTER_MS;
    }

    // No liveness report for this device yet — fall back to telemetry recency,
    // which is all there is to go on until the first heartbeat lands.
    const last = lastUpdate[channelId];
    if (last === undefined) return false; // never had data; not "stale"
    return now - last > STALE_AFTER_MS;
  };

  const staleCount = channels.filter(ch => isChannelStale(ch.id)).length;

  return { isConnected, isChannelStale, staleCount, staleAfterMs: STALE_AFTER_MS };
}
