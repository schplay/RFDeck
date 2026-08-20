import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useChannelStore } from '../../stores/channelStore';
import { useActiveChannels } from '../../hooks/useActiveChannels';
import { useLayoutStore, useOrderedChannels, useDragReorder, useFlipAnimation } from '../../stores/layoutStore';
import { useSocket } from '../../hooks/useSocket';
import { Channel } from '@rfdeck/shared-types';
import './BackstageView.css';

function batteryIcon(pct?: number): string {
  if (pct === undefined) return '🔋';
  if (pct > 60) return '🔋';
  if (pct > 30) return '🪫';
  return '⚡';
}

function statusLabel(ch: Channel): string {
  if (ch.isMuted) return 'MUTED';
  if (ch.status === 'CRITICAL') return 'DROPOUT';
  if (ch.status === 'WARNING') return 'LOW SIGNAL';
  return 'ON AIR';
}

function rfBar(level: number) {
  const segs = 8;
  const active = Math.round((level / 100) * segs);
  return (
    <div className="bs-rf-bar" aria-label={`RF ${level}%`}>
      {Array.from({ length: segs }).map((_, i) => (
        <div
          key={i}
          className={`bs-rf-seg ${i < active ? (level < 20 ? 'crit' : level < 40 ? 'warn' : 'good') : ''}`}
        />
      ))}
    </div>
  );
}

// AF uses audio-level semantics (matches dashboard ChannelStrip): high level =
// hot/clipping, so the TOP segments go orange (≥60%) and red (≥80%) — unlike RF
// where a LOW level is the problem.
function afBar(level: number) {
  const segs = 8;
  const active = Math.round((level / 100) * segs);
  return (
    <div className="bs-rf-bar" aria-label={`AF ${level}%`}>
      {Array.from({ length: segs }).map((_, i) => (
        <div
          key={i}
          className={`bs-rf-seg ${i < active ? (i / segs >= 0.8 ? 'crit' : i / segs >= 0.6 ? 'warn' : 'good') : ''}`}
        />
      ))}
    </div>
  );
}

export default function BackstageView() {
  const channels = useActiveChannels();
  const { socket } = useSocket();

  // Subscribe to channel telemetry
  const updateChannel = useChannelStore((s) => s.updateChannel);
  useEffect(() => {
    if (!socket) return;
    const handler = (ch: Channel) => updateChannel(ch.id, ch);
    socket.on('channel:telemetry', handler);
    return () => { socket.off('channel:telemetry', handler); };
  }, [socket, updateChannel]);

  // Column count is persisted in the layout store so it survives navigation.
  const cols = useLayoutStore(s => s.backstageCols);
  const setCols = useLayoutStore(s => s.setBackstageCols);

  // Pressing 1-4 changes column layout; Escape exits full-screen hint
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key >= '1' && e.key <= '4') setCols(parseInt(e.key));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setCols]);

  const orderMode = useLayoutStore(s => s.orderMode);
  const setOrderMode = useLayoutStore(s => s.setOrderMode);
  const orderedChannels = useOrderedChannels(channels);
  const displayChannels = orderedChannels.length > 0 ? orderedChannels : demoChannels;
  const { enabled: dragEnabled, handlers: dragHandlers } = useDragReorder(orderedChannels);
  const setFlipRef = useFlipAnimation(displayChannels.map(ch => ch.id).join('|'));

  return (
    <div className="bs-root">
      <div className="bs-topbar">
        <div className="bs-brand">RFDeck <span className="bs-brand-sub">BACKSTAGE</span></div>
        <div className="bs-controls">
          <span className="bs-hint">{dragEnabled ? 'Drag cards to reorder' : 'Press 1–4 to change columns'}</span>
          <button
            className={`bs-col-btn bs-order-btn ${orderMode === 'custom' ? 'active' : ''}`}
            onClick={() => setOrderMode(orderMode === 'custom' ? 'alpha' : 'custom')}
            title={orderMode === 'custom' ? 'Using custom order — click for A-Z' : 'Using A-Z order — click for custom'}
          >
            {orderMode === 'custom' ? 'Custom' : 'A–Z'}
          </button>
          {[1, 2, 3, 4].map(n => (
            <button
              key={n}
              className={`bs-col-btn ${cols === n ? 'active' : ''}`}
              onClick={() => setCols(n)}
            >
              {n}
            </button>
          ))}
          <Link to="/" className="bs-exit-btn">← Operator View</Link>
        </div>
      </div>

      <div className="bs-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {displayChannels.map((ch) => {
          const st = statusLabel(ch);
          const stClass = ch.isMuted ? 'muted' : ch.status === 'CRITICAL' ? 'critical' : ch.status === 'WARNING' ? 'warning' : 'active';
          return (
            <div key={ch.id} ref={setFlipRef(ch.id)} className={`bs-card ${stClass}`} {...dragHandlers(ch)}>
              <div className="bs-card-header">
                <div className="bs-ch-name">{ch.name || `CH ${ch.channelIndex}`}</div>
                <div className={`bs-status-pill ${stClass}`}>{st}</div>
              </div>

              <div className="bs-freq">
                {ch.frequency > 0 ? (ch.frequency / 1000).toFixed(3) : '—.———'}
                <span className="bs-freq-unit">MHz</span>
              </div>

              <div className="bs-meters">
                <div className="bs-meter-group">
                  <div className="bs-meter-label">RF A</div>
                  {rfBar(ch.rfLevelA)}
                  <div className="bs-meter-val">{Math.round(ch.rfLevelA)}%</div>
                </div>
                <div className="bs-meter-group">
                  <div className="bs-meter-label">RF B</div>
                  {rfBar(ch.rfLevelB)}
                  <div className="bs-meter-val">{Math.round(ch.rfLevelB)}%</div>
                </div>
                <div className="bs-meter-group">
                  <div className="bs-meter-label">AF</div>
                  {afBar(ch.afLevel)}
                  <div className="bs-meter-val">{Math.round(ch.afLevel)}%</div>
                </div>
              </div>

              {ch.batteryPercent !== undefined && (
                <div className={`bs-battery ${ch.batteryPercent <= 5 ? 'bs-batt-critical' : ch.batteryPercent <= 20 ? 'bs-batt-low' : ''}`}>
                  <div className="bs-batt-bar-track">
                    <div
                      className="bs-batt-bar-fill"
                      style={{ width: `${ch.batteryPercent}%` }}
                    />
                  </div>
                  <span className="bs-batt-label">{Math.round(ch.batteryPercent)}%</span>
                </div>
              )}
            </div>
          );
        })}

        {displayChannels.length === 0 && (
          <div className="bs-empty">
            <div className="bs-empty-icon">📡</div>
            <div className="bs-empty-text">No active channels</div>
            <div className="bs-empty-sub">Devices will appear here once connected</div>
          </div>
        )}
      </div>
    </div>
  );
}

// Demo data shown when no real channels are available
const demoChannels: Channel[] = [
  { id: 'demo-1', deviceId: 'demo', channelIndex: 1, name: 'VOX 1 — Lead', frequency: 614500, rfLevelA: 85, rfLevelB: 82, afLevel: 60, batteryPercent: 78, isMuted: false, status: 'ACTIVE' },
  { id: 'demo-2', deviceId: 'demo', channelIndex: 2, name: 'VOX 2 — Keys', frequency: 622375, rfLevelA: 72, rfLevelB: 68, afLevel: 45, batteryPercent: 22, isMuted: false, status: 'WARNING' },
  { id: 'demo-3', deviceId: 'demo', channelIndex: 3, name: 'IEM L — Lead', frequency: 630250, rfLevelA: 90, rfLevelB: 88, afLevel: 0, batteryPercent: 55, isMuted: true, status: 'WARNING' },
  { id: 'demo-4', deviceId: 'demo', channelIndex: 4, name: 'VOX 3 — Drums', frequency: 638125, rfLevelA: 15, rfLevelB: 12, afLevel: 0, batteryPercent: 4, isMuted: false, status: 'CRITICAL' },
];
