import React, { useState } from 'react';
import { Battery, BatteryCharging, BatteryWarning, AlertTriangle } from 'lucide-react';
import { useActiveChannels } from '../../hooks/useActiveChannels';
import { useBatteryStore, formatRuntime } from '../../stores/batteryStore';
import { useDeviceStore } from '../../stores/deviceStore';
import { BATT_LOW, BATT_CRIT, channelPlace } from '../../lib/channelStatus';
import './BatteryDashboard.css';

export default function BatteryDashboard() {
  // Inactive devices are intentionally powered off — their packs are not a
  // battery concern and must not appear in the low/critical tallies.
  const channels = useActiveChannels();
  const estimates = useBatteryStore(s => s.estimates);
  const showMinutes = useBatteryStore(s => s.showMinutes);
  const setShowMinutes = useBatteryStore(s => s.setShowMinutes);
  
  const inventory = useDeviceStore(s => s.inventory);
  const nameFor = (deviceId: string) => inventory.find(d => d.ip === deviceId.split(':')[0])?.name;

  // A pack is "at risk" only when the server is confident enough to project.
  // An unknown runtime is never treated as a failure — that would cry wolf on
  // every freshly-fitted pack.
  const willRunOut = (channelId: string): boolean => {
    const est = estimates[channelId];
    if (!est?.confident || est.minutesRemaining === null) return false;
    return est.minutesRemaining < showMinutes;
  };

  // Most urgent first: packs that will not last the show, then the shortest
  // projected runtime, then the lowest charge for packs still being measured.
  // Charge alone put a 40% pack draining fast below a 30% one that would last.
  const runtimeOf = (id: string) => {
    const est = estimates[id];
    return est?.confident && est.minutesRemaining !== null ? est.minutesRemaining : Infinity;
  };
  const sortedChannels = [...channels]
    .filter(c => c.batteryPercent !== undefined)
    .sort((a, b) =>
      Number(willRunOut(b.id)) - Number(willRunOut(a.id)) ||
      runtimeOf(a.id) - runtimeOf(b.id) ||
      (a.batteryPercent ?? 100) - (b.batteryPercent ?? 100));

  const criticalPacks = sortedChannels.filter(c => (c.batteryPercent ?? 100) <= BATT_CRIT);
  const lowPacks = sortedChannels.filter(c => (c.batteryPercent ?? 100) > BATT_CRIT && (c.batteryPercent ?? 100) <= BATT_LOW);
  const atRiskPacks = sortedChannels.filter(c => willRunOut(c.id));
  const measuring = sortedChannels.filter(c => !estimates[c.id]?.confident).length;

  const getBatteryIcon = (percent: number) => {
    if (percent <= 10) return <BatteryWarning size={20} className="text-error" />;
    if (percent < 100) return <Battery size={20} className={percent <= BATT_LOW ? 'text-warning' : 'text-muted'} />;
    return <BatteryCharging size={20} className="text-success" />;
  };

  return (
    <div className="battery-page">
      <div className="battery-header">
        <h1>Batteries</h1>
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

      {/* The answer before curtain, in one sentence. */}
      {sortedChannels.length > 0 && (
        <div className={`battery-verdict ${atRiskPacks.length > 0 || criticalPacks.length > 0 ? 'is-bad' : ''}`} role="status">
          {atRiskPacks.length > 0
            ? <><strong>{atRiskPacks.length === 1 ? '1 pack' : `${atRiskPacks.length} packs`} won't last the next {showMinutes} minutes:</strong> {atRiskPacks.map(c => c.name || `CH ${c.channelIndex}`).join(', ')}</>
            : criticalPacks.length > 0
              ? <><strong>Replace now:</strong> {criticalPacks.map(c => c.name || `CH ${c.channelIndex}`).join(', ')}</>
              : measuring === sortedChannels.length
                ? <>Runtime estimates appear once each pack has a few minutes of readings.</>
                : measuring > 0
                  ? <>Every measured pack will last the next {showMinutes} minutes. Still measuring {measuring}.</>
                  : <>Every pack will last the next {showMinutes} minutes.</>}
        </div>
      )}

      <div className="battery-grid">
        {sortedChannels.length === 0 ? (
          <p className="no-data">No battery telemetry available.</p>
        ) : (
          sortedChannels.map(ch => {
            const pct = ch.batteryPercent ?? 0;
            const isCritical = pct <= BATT_CRIT;
            const isLow = pct <= BATT_LOW && !isCritical;
            
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
                    {channelPlace(ch, nameFor(ch.deviceId))}
                  </div>
                </div>

                {/* Runtime is withheld until the server has enough history to
                    mean something — a confident-looking wrong number is worse
                    than an honest dash. */}
                <div className="bc-runtime">
                  <span className="bc-runtime-label">Est. runtime</span>
                  <span className={`bc-runtime-value ${atRisk ? 'at-risk' : ''} ${est?.confident ? '' : 'is-pending'}`}>
                    {est?.confident ? formatRuntime(est.minutesRemaining) : 'Measuring…'}
                  </span>
                  {est?.confident && est.drainPerHour > 0 && (
                    <span className="bc-drain">{est.drainPerHour.toFixed(1)}%/hr</span>
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
