import React, { useMemo, useRef, useEffect, useState } from 'react';
import { Radio, Download, Wifi, AlertTriangle, CheckCircle, Trash2 } from 'lucide-react';
import { useDeviceStore } from '../../stores/deviceStore';
import { useActiveChannels } from '../../hooks/useActiveChannels';
import { apiFetch } from '../../lib/api';
import { useRfEventStore } from '../../stores/rfEventStore';
import { SpectrumCanvas } from './components/SpectrumCanvas';
import { FrequencyTable } from './components/FrequencyTable';
import './RFScanner.css';

function RfEventLog() {
  const events = useRfEventStore(s => s.events);

  // The log lives on the server, so clearing has to happen there — the
  // rf:events-cleared broadcast then empties every client.
  const clearAll = async () => {
    try {
      await apiFetch('/system/rf-events', { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to clear RF event log:', err);
    }
  };
  const formatTime = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="rf-event-log">
      <div className="rf-event-log-toolbar">
        <span className="rf-event-log-count">{events.length} events</span>
        <button className="fh-action-btn danger" onClick={() => events.length && window.confirm('Clear RF event log?') && clearAll()} disabled={events.length === 0} title="Clear log">
          <Trash2 size={13} />
        </button>
      </div>
      {events.length === 0 ? (
        <div className="rf-event-empty">No RF events recorded — dropouts and recoveries will appear here</div>
      ) : (
        <div className="rf-event-list">
          {events.map((e) => (
            <div key={e.id} className={`rf-event-row rf-event-${e.type.toLowerCase()}`}>
              <div className="rf-event-icon">
                {e.type === 'DROPOUT' ? <AlertTriangle size={13} /> : <CheckCircle size={13} />}
              </div>
              <div className="rf-event-body">
                <span className="rf-event-ch">{e.channelName}</span>
                <span className="rf-event-type">{e.type === 'DROPOUT' ? 'Signal Dropout' : 'Signal Recovered'}</span>
              </div>
              <div className="rf-event-levels">
                <span>A: {Math.round(e.rfLevelA)}%</span>
                <span>B: {Math.round(e.rfLevelB)}%</span>
              </div>
              <div className="rf-event-time">{formatTime(e.timestamp)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RFScanner() {
  // Inactive devices are intentionally powered off — exclude them here as the
  // dashboard, backstage, and mic check already do.
  const channels = useActiveChannels();
  const { inventory } = useDeviceStore();

  const onlineDevices = inventory.filter((d) => d.online && d.active !== false).length;
  const activeChannels = channels.filter((c) => c.status === 'ACTIVE');

  const handleExportCSV = () => {
    const rows = [
      ['Channel Name', 'Frequency (MHz)', 'Device', 'Status', 'RF Level A', 'RF Level B'],
      ...channels.map((c) => [
        c.name,
        (c.frequency / 1000).toFixed(3),
        c.deviceId,
        c.status,
        String(Math.round(c.rfLevelA)),
        String(Math.round(c.rfLevelB)),
      ]),
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rfdeck-frequencies-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rf-page">
      {/* Page Header */}
      <div className="rf-header">
        <div className="rf-header-left">
          <h1 className="page-title">RF Environment</h1>
          <div className="rf-stats">
            <span className="stat-badge stat-total">
              <Wifi size={12} />
              {onlineDevices} Devices Online
            </span>
            <span className="stat-badge stat-online">
              <Radio size={12} />
              {channels.length} Active Frequencies
            </span>
          </div>
        </div>
        <div className="rf-header-actions">
          <button className="btn-secondary-rf" onClick={handleExportCSV} disabled={channels.length === 0}>
            <Download size={15} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Main layout: spectrum + table + sidebar */}
      <div className="rf-workspace">
        {/* Left column: stacked spectrum + table */}
        <div className="rf-main-col">
          {/* Spectrum Visualization */}
          {/* Frequencies and signal strength as reported by connected
              receivers. RFDeck does not scan the spectrum — it maps what our
              own hardware tells us it is doing. */}
          <section className="rf-card spectrum-card">
            <div className="rf-card-header">
              <div className="rf-card-title">
                <Radio size={16} className="card-icon" />
                Channel Frequency Map
              </div>
              <div className="spectrum-meta">
                <span>470 – 608 MHz</span>
                <span>{channels.length} connected</span>
              </div>
            </div>
            <div className="spectrum-body">
              <SpectrumCanvas channels={channels} />
            </div>
          </section>

          {/* Frequency Table */}
          <section className="rf-card table-card">
            <div className="rf-card-header">
              <div className="rf-card-title">Active Frequencies</div>
              <span className="table-count">{channels.length} channels</span>
            </div>
            <FrequencyTable channels={channels} />
          </section>

          {/* RF Signal Event Log */}
          <section className="rf-card history-card">
            <div className="rf-card-header">
              <div className="rf-card-title">
                <AlertTriangle size={16} className="card-icon" />
                RF Signal Events
              </div>
            </div>
            <RfEventLog />
          </section>
        </div>

        {/* Right sidebar */}
        <aside className="rf-sidebar">
          <div className="rf-card sidebar-card">
            <div className="sidebar-section-title">Network Status</div>
            <div className="sidebar-stat-block">
              <div className="sidebar-stat">
                <span className="sidebar-stat-label">Online Devices</span>
                <span className="sidebar-stat-value">{onlineDevices}</span>
              </div>
              <div className="sidebar-stat">
                <span className="sidebar-stat-label">Total Channels</span>
                <span className="sidebar-stat-value">{channels.length}</span>
              </div>
              <div className="sidebar-stat">
                <span className="sidebar-stat-label">Active</span>
                <span className="sidebar-stat-value success">{activeChannels.length}</span>
              </div>
              <div className="sidebar-stat">
                <span className="sidebar-stat-label">Warning / Critical</span>
                <span className="sidebar-stat-value warning">
                  {channels.filter((c) => c.status !== 'ACTIVE').length}
                </span>
              </div>
            </div>
          </div>

          <div className="rf-card sidebar-card">
            <div className="sidebar-section-title">Frequency Range</div>
            <div className="freq-range-display">
              {channels.length > 0 ? (
                <>
                  <div className="freq-range-row">
                    <span className="freq-range-label">Lowest</span>
                    <span className="freq-range-value">
                      {(Math.min(...channels.map((c) => c.frequency)) / 1000).toFixed(3)} MHz
                    </span>
                  </div>
                  <div className="freq-range-row">
                    <span className="freq-range-label">Highest</span>
                    <span className="freq-range-value">
                      {(Math.max(...channels.map((c) => c.frequency)) / 1000).toFixed(3)} MHz
                    </span>
                  </div>
                  <div className="freq-range-row">
                    <span className="freq-range-label">Span</span>
                    <span className="freq-range-value">
                      {((Math.max(...channels.map((c) => c.frequency)) - Math.min(...channels.map((c) => c.frequency))) / 1000).toFixed(3)} MHz
                    </span>
                  </div>
                </>
              ) : (
                <p className="no-data">No active channels detected</p>
              )}
            </div>
          </div>

          <div className="rf-card sidebar-card">
            <div className="sidebar-section-title">About This View</div>
            <p className="sidebar-note">
              This view shows the RF environment based on live telemetry from your connected hardware. For full frequency coordination and IMD calculation, use your manufacturer's tools (Sennheiser WSM, Shure WWB6).
            </p>
          </div>

        </aside>
      </div>
    </div>
  );
}
