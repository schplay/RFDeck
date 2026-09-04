import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Channel } from '@rfdeck/shared-types';
import { useActiveChannels } from '../../hooks/useActiveChannels';
import { useConnectionHealth } from '../../hooks/useConnectionHealth';
import { useDeviceStore } from '../../stores/deviceStore';
import { channelKey } from '../../lib/channelKey';
import { API_BASE } from '../../lib/api';
import './MicboardView.css';

// The Micboard: one tile per channel, each showing who is on it.
//
// This is the screen on the wall backstage, read across a room by people who
// are not looking for it — an A2 passing a rack, a stage manager glancing up.
// So the tile leads with the face and the name, and the meters are large
// enough to read at a glance rather than dense enough to study.
//
// Read-only by design: it issues no commands, and the server will not accept
// any from it. That is what lets a display run without anyone typing the PIN.

interface Assignment {
  name: string;
  role: string;
  photoUrl: string | null;
  isIem: boolean;
}

interface MicboardData {
  live: boolean;
  show: { id: string; name: string; currentAct: number } | null;
  assignments: Record<string, Assignment>;
}

function statusOf(ch: Channel, online: boolean, stale: boolean): {
  label: string; tone: 'good' | 'warn' | 'crit' | 'idle';
} {
  if (!online) return { label: 'OFFLINE', tone: 'crit' };
  if (stale) return { label: 'NO DATA', tone: 'crit' };
  if (ch.isMuted) return { label: 'MUTED', tone: 'warn' };
  if (ch.isTxMuted) return { label: 'TX MUTED', tone: 'idle' };
  if (ch.status === 'CRITICAL') return { label: 'DROPOUT', tone: 'crit' };
  if (ch.status === 'WARNING') return { label: 'LOW RF', tone: 'warn' };
  return { label: 'ON AIR', tone: 'good' };
}

function Meter({ value, kind }: { value: number; kind: 'rf' | 'af' | 'batt' }) {
  const pct = Math.max(0, Math.min(100, value));
  // RF and battery are bad when low; audio is bad when pinned high.
  const tone = kind === 'af'
    ? (pct > 92 ? 'crit' : pct > 80 ? 'warn' : 'good')
    : (pct < 20 ? 'crit' : pct < 40 ? 'warn' : 'good');
  return (
    <div className={`mb-meter mb-meter-${tone}`}>
      <div className="mb-meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function MicboardView() {
  const channels = useActiveChannels();
  const inventory = useDeviceStore(s => s.inventory);
  const { isConnected, isChannelStale } = useConnectionHealth();

  const [data, setData] = useState<MicboardData>({ live: false, show: null, assignments: {} });
  const [showPhotos, setShowPhotos] = useState(true);
  const [showHelp, setShowHelp] = useState(false);

  // Who is on each channel changes only when the cast list does, so this is
  // polled slowly rather than pushed — telemetry is what has to be live.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/micboard`);
        if (!res.ok) return;
        const next = await res.json();
        if (!cancelled) setData(next);
      } catch { /* the connection banner already says we are offline */ }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'f') {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => {});
      } else if (e.key === 'g') {
        setShowPhotos(v => !v);
      } else if (e.key === '?') {
        setShowHelp(v => !v);
      } else if (e.key === 'Escape') {
        setShowHelp(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onlineByIp = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const d of inventory) m.set(d.ip, d.online);
    return m;
  }, [inventory]);

  // Alphabetical: a wall display has no operator to reorder it, and a stable
  // order is what lets someone find a name in the same place every time.
  const tiles = useMemo(
    () => [...channels].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [channels],
  );

  return (
    <div className="mb-root">
      {!isConnected && (
        <div className="mb-banner">Disconnected from RFDeck — these readings are frozen</div>
      )}

      <header className="mb-header">
        <div className="mb-title">
          {data.show ? data.show.name : 'RFDeck'}
          {!data.live && <span className="mb-standby">Standing by</span>}
          {data.show && <span className="mb-act">Act {data.show.currentAct}</span>}
        </div>
        <div className="mb-header-right">
          <span className="mb-count">{tiles.length} channels</span>
          <Link to="/" className="mb-exit" title="Back to RFDeck">✕</Link>
        </div>
      </header>

      {tiles.length === 0 ? (
        <div className="mb-empty">
          <p>No active channels.</p>
          <p className="mb-empty-hint">
            {data.live
              ? 'Channels appear here as receivers come online. Photos come from the cast list of the running show.'
              : 'RFDeck is standing by. An operator starts the rig with Go Live.'}
          </p>
        </div>
      ) : (
        <div className="mb-grid" style={{ '--tile-count': tiles.length } as React.CSSProperties}>
          {tiles.map(ch => {
            const key = channelKey(ch);
            const who = data.assignments[key];
            const online = onlineByIp.get(ch.deviceId.split(':')[0]) ?? true;
            const stale = isChannelStale(ch.id);
            const status = statusOf(ch, online, stale);
            const dim = !online || stale;

            return (
              <div key={ch.id} className={`mb-tile mb-tone-${status.tone} ${dim ? 'is-dim' : ''}`}>
                {showPhotos && who?.photoUrl && (
                  <img className="mb-photo" src={`${API_BASE}${who.photoUrl}`} alt="" />
                )}
                <div className="mb-scrim" />

                <div className="mb-tile-top">
                  <span className={`mb-status mb-status-${status.tone}`}>{status.label}</span>
                  {who?.isIem && <span className="mb-iem">IEM</span>}
                </div>

                <div className="mb-tile-body">
                  <div className="mb-who">
                    {who ? (
                      <>
                        <span className="mb-name">{who.name}</span>
                        {who.role && <span className="mb-role">{who.role}</span>}
                      </>
                    ) : (
                      <span className="mb-name mb-unassigned">{ch.name || `CH ${ch.channelIndex}`}</span>
                    )}
                  </div>
                  {who && <div className="mb-channel">{ch.name || `CH ${ch.channelIndex}`}</div>}
                </div>

                <div className="mb-tile-meters">
                  <div className="mb-meter-row">
                    <span className="mb-meter-label">RF</span>
                    <Meter value={dim ? 0 : ch.rfLevelA} kind="rf" />
                    <Meter value={dim ? 0 : ch.rfLevelB} kind="rf" />
                  </div>
                  <div className="mb-meter-row">
                    <span className="mb-meter-label">AF</span>
                    <Meter value={dim ? 0 : ch.afLevel} kind="af" />
                  </div>
                  <div className="mb-foot">
                    <span className="mb-batt">
                      {ch.batteryPercent === undefined ? '—' : `${Math.round(ch.batteryPercent)}%`}
                    </span>
                    <span className="mb-freq">
                      {ch.frequency > 0 ? `${(ch.frequency / 1000).toFixed(3)} MHz` : '—'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showHelp && (
        <div className="mb-help" onClick={() => setShowHelp(false)}>
          <div className="mb-help-card">
            <h2>Micboard</h2>
            <dl>
              <dt>F</dt><dd>Fullscreen</dd>
              <dt>G</dt><dd>Photos on / off</dd>
              <dt>?</dt><dd>This help</dd>
            </dl>
            <p>
              This view is read-only and needs no PIN. Photos come from the cast
              list of the show currently running.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
