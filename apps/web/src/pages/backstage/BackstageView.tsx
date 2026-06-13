import React, { useState, useEffect } from 'react';
import { useChannelStore } from '../../stores/channelStore';
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

export default function BackstageView() {
  const channels = useChannelStore((s) => s.channels);
  const { socket } = useSocket();

  // Subscribe to channel telemetry
  const updateChannel = useChannelStore((s) => s.updateChannel);
  useEffect(() => {
    if (!socket) return;
    const handler = (ch: Channel) => updateChannel(ch.id, ch);
    socket.on('channel:telemetry', handler);
    return () => { socket.off('channel:telemetry', handler); };
  }, [socket, updateChannel]);

  const [cols, setCols] = useState(2);

  // Pressing 1-4 changes column layout; Escape exits full-screen hint
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key >= '1' && e.key <= '4') setCols(parseInt(e.key));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const displayChannels = channels.length > 0 ? channels : demoChannels;

  return (
    <div className="bs-root">
      <div className="bs-topbar">
        <div className="bs-brand">RFDeck <span className="bs-brand-sub">BACKSTAGE</span></div>
        <div className="bs-controls">
          <span className="bs-hint">Press 1–4 to change columns</span>
          {[1, 2, 3, 4].map(n => (
            <button
              key={n}
              className={`bs-col-btn ${cols === n ? 'active' : ''}`}
              onClick={() => setCols(n)}
            >
              {n}
            </button>
          ))}
          <a href="/" className="bs-exit-btn">← Operator View</a>
        </div>
      </div>

      <div className="bs-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {displayChannels.map((ch) => {
          const st = statusLabel(ch);
          const stClass = ch.isMuted ? 'muted' : ch.status === 'CRITICAL' ? 'critical' : ch.status === 'WARNING' ? 'warning' : 'active';
          return (
            <div key={ch.id} className={`bs-card ${stClass}`}>
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
                  <div className="bs-meter-val">{ch.rfLevelA}%</div>
                </div>
                <div className="bs-meter-group">
                  <div className="bs-meter-label">RF B</div>
                  {rfBar(ch.rfLevelB)}
                  <div className="bs-meter-val">{ch.rfLevelB}%</div>
                </div>
                <div className="bs-meter-group">
                  <div className="bs-meter-label">AF</div>
                  {rfBar(ch.afLevel)}
                  <div className="bs-meter-val">{ch.afLevel}%</div>
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
                  <span className="bs-batt-label">{ch.batteryPercent}%</span>
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
