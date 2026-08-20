import React, { useState } from 'react';
import { Battery, BatteryCharging, BatteryWarning, AlertTriangle } from 'lucide-react';
import { useActiveChannels } from '../../hooks/useActiveChannels';
import { useBatteryStore, formatRuntime } from '../../stores/batteryStore';
import './BatteryDashboard.css';

export default function BatteryDashboard() {
  // Inactive devices are intentionally powered off — their packs are not a
  // battery concern and must not appear in the low/critical tallies.
  const channels = useActiveChannels();
  const estimates = useBatteryStore(s => s.estimates);
  const showMinutes = useBatteryStore(s => s.showMinutes);
  const setShowMinutes = useBatteryStore(s => s.setShowMinutes);
  
  // Sort channels by lowest battery first
  const sortedChannels = [...channels]
    .filter(c => c.batteryPercent !== undefined)
    .sort((a, b) => (a.batteryPercent ?? 100) - (b.batteryPercent ?? 100));

  const criticalPacks = sortedChannels.filter(c => (c.batteryPercent ?? 100) <= 5);
  const lowPacks = sortedChannels.filter(c => (c.batteryPercent ?? 100) > 5 && (c.batteryPercent ?? 100) <= 20);

  // A pack is "at risk" only when the server is confident enough to project.
  // An unknown runtime is never treated as a failure — that would cry wolf on
  // every freshly-fitted pack.
  const willRunOut = (channelId: string): boolean => {
    const est = estimates[channelId];
    if (!est?.confident || est.minutesRemaining === null) return false;
    return est.minutesRemaining < showMinutes;
  };

  const atRiskPacks = sortedChannels.filter(c => willRunOut(c.id));

  const getBatteryIcon = (percent: number) => {
    if (percent <= 10) return <BatteryWarning size={20} className="text-error" />;
    if (percent < 100) return <Battery size={20} className={percent <= 20 ? 'text-warning' : 'text-success'} />;
    return <BatteryCharging size={20} className="text-success" />;
  };

  return (
    <div className="battery-page">
      <div className="battery-header">
        <h1>Battery Management</h1>
        <div className="battery-summary">
          <div className="summary-stat">
            <span className="stat-label">Total Packs</span>
            <span className="stat-value">{sortedChannels.length}</span>
          </div>
          <div className="summary-stat">
            <span className="stat-label">Low (&lt;20%)</span>
            <span className="stat-value warning">{lowPacks.length}</span>
          </div>
          <div className="summary-stat">
            <span className="stat-label">Critical (&lt;5%)</span>
            <span className="stat-value error">{criticalPacks.length}</span>
          </div>
          {/* The question that actually matters before curtain. */}
          <div className="summary-stat">
            <span className="stat-label">Won't last show</span>
            <span className={`stat-value ${atRiskPacks.length > 0 ? 'error' : ''}`}>
              {atRiskPacks.length}
            </span>
          </div>
        </div>
      </div>

      <div className="battery-showlen">
        <label htmlFor="show-minutes">Remaining show length</label>
        <input
          id="show-minutes"
          type="number"
          min={0}
          max={600}
          step={15}
          value={showMinutes}
          onChange={e => setShowMinutes(Number(e.target.value))}
        />
        <span className="battery-showlen-unit">minutes</span>
        <span className="battery-showlen-hint">
          Packs projected to run out before this are flagged.
        </span>
      </div>

      <div className="battery-grid">
        {sortedChannels.length === 0 ? (
          <p className="no-data">No battery telemetry available.</p>
        ) : (
          sortedChannels.map(ch => {
            const pct = ch.batteryPercent ?? 0;
            const isCritical = pct <= 5;
            const isLow = pct <= 20 && !isCritical;
            
            const est = estimates[ch.id];
            const atRisk = willRunOut(ch.id);

            return (
              <div
                key={ch.id}
                className={`battery-card ${isCritical ? 'critical' : isLow ? 'low' : ''} ${atRisk ? 'at-risk' : ''}`}
              >
                <div className="bc-header">
                  <h3>{ch.name || `CH ${ch.channelIndex}`}</h3>
                  {getBatteryIcon(pct)}
                </div>
                <div className="bc-body">
                  <div className="bc-percent-large">{Math.round(pct)}%</div>
                  <div className="bc-device-info">
                    {ch.deviceId.split(':')[0]}
                  </div>
                </div>

                {/* Runtime is withheld until the server has enough history to
                    mean something — a confident-looking wrong number is worse
                    than an honest dash. */}
                <div className="bc-runtime">
                  <span className="bc-runtime-label">Est. runtime</span>
                  <span className={`bc-runtime-value ${atRisk ? 'at-risk' : ''}`}>
                    {est?.confident ? formatRuntime(est.minutesRemaining) : '—'}
                  </span>
                  {est?.confident && est.drainPerHour > 0 && (
                    <span className="bc-drain">{est.drainPerHour.toFixed(1)}%/hr</span>
                  )}
                  {!est?.confident && (
                    <span className="bc-drain">measuring…</span>
                  )}
                </div>

                <div className="bc-footer">
                  <div className="bc-progress-bar">
                    <div
                      className={`bc-fill ${isCritical ? 'fill-red' : isLow ? 'fill-orange' : 'fill-green'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {isCritical ? (
                    <div className="bc-alert">
                      <AlertTriangle size={12} /> Replace immediately
                    </div>
                  ) : atRisk ? (
                    <div className="bc-alert bc-alert-warn">
                      <AlertTriangle size={12} /> Won't last the show
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
