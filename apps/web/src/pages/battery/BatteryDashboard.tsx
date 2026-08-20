import React, { useState } from 'react';
import { Battery, BatteryCharging, BatteryWarning, AlertTriangle } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import './BatteryDashboard.css';

export default function BatteryDashboard() {
  const { channels } = useChannelStore();
  
  // Sort channels by lowest battery first
  const sortedChannels = [...channels]
    .filter(c => c.batteryPercent !== undefined)
    .sort((a, b) => (a.batteryPercent ?? 100) - (b.batteryPercent ?? 100));

  const criticalPacks = sortedChannels.filter(c => (c.batteryPercent ?? 100) <= 5);
  const lowPacks = sortedChannels.filter(c => (c.batteryPercent ?? 100) > 5 && (c.batteryPercent ?? 100) <= 20);

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
        </div>
      </div>

      <div className="battery-grid">
        {sortedChannels.length === 0 ? (
          <p className="no-data">No battery telemetry available.</p>
        ) : (
          sortedChannels.map(ch => {
            const pct = ch.batteryPercent ?? 0;
            const isCritical = pct <= 5;
            const isLow = pct <= 20 && !isCritical;
            
            return (
              <div key={ch.id} className={`battery-card ${isCritical ? 'critical' : isLow ? 'low' : ''}`}>
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
                <div className="bc-footer">
                  <div className="bc-progress-bar">
                    <div 
                      className={`bc-fill ${isCritical ? 'fill-red' : isLow ? 'fill-orange' : 'fill-green'}`} 
                      style={{ width: `${pct}%` }} 
                    />
                  </div>
                  {isCritical && (
                    <div className="bc-alert">
                      <AlertTriangle size={12} /> Replace immediately
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
