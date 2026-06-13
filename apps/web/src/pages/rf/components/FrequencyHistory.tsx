import React, { useState, useMemo } from 'react';
import { FrequencyChangeEvent, useFrequencyHistoryStore } from '../../../stores/frequencyHistoryStore';
import { History, Trash2, Download, ChevronUp, ChevronDown, Radio, Pencil } from 'lucide-react';
import './FrequencyHistory.css';

type SortKey = 'timestamp' | 'channelName' | 'newFrequencyHz' | 'delta';
type SortDir = 'asc' | 'desc';

function formatFreq(hz: number) {
  return (hz / 1000).toFixed(3);
}

function formatDelta(prev: number, next: number) {
  const delta = (next - prev) / 1000; // kHz → MHz
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(3)}`;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface Props {
  filterChannelId?: string; // optional: only show events for one channel
  compact?: boolean;         // compact mode for sidebar embed
}

export function FrequencyHistory({ filterChannelId, compact = false }: Props) {
  const { events, clearAll, clearForChannel } = useFrequencyHistoryStore();
  const [sortKey, setSortKey] = useState<SortKey>('timestamp');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filterSource, setFilterSource] = useState<'ALL' | 'TELEMETRY' | 'MANUAL'>('ALL');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let list = filterChannelId
      ? events.filter((e) => e.channelId === filterChannelId)
      : events;

    if (filterSource !== 'ALL') {
      list = list.filter((e) => e.source === filterSource);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (e) =>
          e.channelName.toLowerCase().includes(q) ||
          formatFreq(e.newFrequencyHz).includes(q) ||
          formatFreq(e.previousFrequencyHz).includes(q)
      );
    }

    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'timestamp') cmp = a.timestamp.localeCompare(b.timestamp);
      else if (sortKey === 'channelName') cmp = a.channelName.localeCompare(b.channelName);
      else if (sortKey === 'newFrequencyHz') cmp = a.newFrequencyHz - b.newFrequencyHz;
      else if (sortKey === 'delta')
        cmp = Math.abs(a.newFrequencyHz - a.previousFrequencyHz) -
              Math.abs(b.newFrequencyHz - b.previousFrequencyHz);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [events, filterChannelId, filterSource, search, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  const SortIcon = ({ k }: { k: SortKey }) =>
    sortKey === k ? (
      sortDir === 'desc' ? <ChevronDown size={12} /> : <ChevronUp size={12} />
    ) : null;

  const handleExport = () => {
    const rows = [
      ['Timestamp', 'Channel', 'Device', 'Previous (MHz)', 'New (MHz)', 'Delta (MHz)', 'Source'],
      ...filtered.map((e) => [
        e.timestamp,
        e.channelName,
        e.deviceId,
        formatFreq(e.previousFrequencyHz),
        formatFreq(e.newFrequencyHz),
        formatDelta(e.previousFrequencyHz, e.newFrequencyHz),
        e.source,
      ]),
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rfdeck-freq-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (compact) {
    // Compact view: last 10 events, no sorting/filter controls
    const recent = filtered.slice(0, 10);
    return (
      <div className="fh-compact">
        <div className="fh-compact-header">
          <span className="fh-compact-title">
            <History size={13} /> Frequency Changes
          </span>
          <span className="fh-compact-count">{events.length}</span>
        </div>
        {recent.length === 0 ? (
          <div className="fh-compact-empty">No changes recorded yet</div>
        ) : (
          <div className="fh-compact-list">
            {recent.map((e) => (
              <div key={e.id} className="fh-compact-row">
                <div className="fh-compact-ch">{e.channelName}</div>
                <div className="fh-compact-freqs">
                  <span className="fh-prev">{formatFreq(e.previousFrequencyHz)}</span>
                  <span className="fh-arrow">→</span>
                  <span className="fh-new">{formatFreq(e.newFrequencyHz)}</span>
                  <span className="fh-unit">MHz</span>
                </div>
                <div className="fh-compact-meta">
                  <span
                    className={`fh-source-badge ${e.source === 'MANUAL' ? 'manual' : 'telem'}`}
                  >
                    {e.source === 'MANUAL' ? <Pencil size={9} /> : <Radio size={9} />}
                  </span>
                  <span className="fh-time">{formatTime(e.timestamp)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Full view
  return (
    <div className="fh-root">
      {/* Toolbar */}
      <div className="fh-toolbar">
        <div className="fh-toolbar-left">
          <input
            type="text"
            className="fh-search"
            placeholder="Filter by channel or frequency…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="fh-filter-pills">
            {(['ALL', 'TELEMETRY', 'MANUAL'] as const).map((s) => (
              <button
                key={s}
                className={`fh-pill ${filterSource === s ? 'active' : ''}`}
                onClick={() => setFilterSource(s)}
              >
                {s === 'TELEMETRY' && <Radio size={11} />}
                {s === 'MANUAL' && <Pencil size={11} />}
                {s === 'ALL' ? 'All' : s === 'TELEMETRY' ? 'Hardware' : 'Manual'}
              </button>
            ))}
          </div>
        </div>
        <div className="fh-toolbar-right">
          <span className="fh-count">{filtered.length} events</span>
          <button
            className="fh-action-btn"
            onClick={handleExport}
            disabled={filtered.length === 0}
            title="Export CSV"
          >
            <Download size={14} />
          </button>
          <button
            className="fh-action-btn danger"
            onClick={() => {
              if (filterChannelId) clearForChannel(filterChannelId);
              else if (window.confirm('Clear all frequency change history?')) clearAll();
            }}
            disabled={filtered.length === 0}
            title="Clear history"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="fh-empty">
          <History size={36} />
          <p>No frequency changes recorded</p>
          <span>Changes will appear here automatically when hardware reports a new frequency.</span>
        </div>
      ) : (
        <div className="fh-table-wrap">
          <table className="fh-table">
            <thead>
              <tr>
                <th className="fh-th sortable" onClick={() => handleSort('timestamp')}>
                  Time <SortIcon k="timestamp" />
                </th>
                <th className="fh-th sortable" onClick={() => handleSort('channelName')}>
                  Channel <SortIcon k="channelName" />
                </th>
                <th className="fh-th">Previous</th>
                <th className="fh-th sortable" onClick={() => handleSort('newFrequencyHz')}>
                  New <SortIcon k="newFrequencyHz" />
                </th>
                <th className="fh-th sortable" onClick={() => handleSort('delta')}>
                  Delta <SortIcon k="delta" />
                </th>
                <th className="fh-th">Source</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => {
                const delta = e.newFrequencyHz - e.previousFrequencyHz;
                const deltaClass = delta > 0 ? 'positive' : delta < 0 ? 'negative' : '';
                return (
                  <tr key={e.id} className={`fh-row ${i % 2 === 0 ? '' : 'alt'}`}>
                    <td className="fh-td fh-td-time">
                      <div className="fh-time-cell">
                        <span className="fh-time-date">{formatDate(e.timestamp)}</span>
                        <span className="fh-time-val">{formatTime(e.timestamp)}</span>
                      </div>
                    </td>
                    <td className="fh-td fh-td-channel">
                      <span className="fh-ch-name">{e.channelName}</span>
                      <span className="fh-device-id">{e.deviceId.split(':')[0]}</span>
                    </td>
                    <td className="fh-td fh-td-mono fh-prev-freq">
                      {formatFreq(e.previousFrequencyHz)}
                      <span className="fh-mhz-unit">MHz</span>
                    </td>
                    <td className="fh-td fh-td-mono fh-new-freq">
                      {formatFreq(e.newFrequencyHz)}
                      <span className="fh-mhz-unit">MHz</span>
                    </td>
                    <td className={`fh-td fh-td-mono fh-delta ${deltaClass}`}>
                      {formatDelta(e.previousFrequencyHz, e.newFrequencyHz)}
                    </td>
                    <td className="fh-td">
                      <span className={`fh-source-badge ${e.source === 'MANUAL' ? 'manual' : 'telem'}`}>
                        {e.source === 'MANUAL' ? <Pencil size={10} /> : <Radio size={10} />}
                        {e.source === 'MANUAL' ? 'Manual' : 'Hardware'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
