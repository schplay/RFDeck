import React, { useState, useMemo } from 'react';
import { FrequencyChangeEvent, useFrequencyHistoryStore } from '../../../stores/frequencyHistoryStore';
import { useDeviceStore } from '../../../stores/deviceStore';
import { History, Download, ChevronUp, ChevronDown, Radio, SlidersHorizontal } from 'lucide-react';
import './FrequencyHistory.css';

// Every time a carrier moved, newest first: who moved it (RFDeck, or someone
// at the receiver), from where to where. The history is the server's, so it
// covers time when no screen was open and reads the same on every screen.

type SortKey = 'timestamp' | 'channelName' | 'toKHz' | 'delta';
type SortDir = 'asc' | 'desc';
type Origin = 'ALL' | 'FREQUENCY_CHANGE' | 'FREQUENCY_SET';

const ORIGIN_LABEL: Record<FrequencyChangeEvent['type'], string> = {
  FREQUENCY_CHANGE: 'At the receiver',
  FREQUENCY_SET: 'RFDeck',
};

function formatFreq(kHz: number) {
  return (kHz / 1000).toFixed(3);
}

function formatDelta(fromKHz: number, toKHz: number) {
  const delta = (toKHz - fromKHz) / 1000;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(3)}`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(iso: string) {
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) return 'Today';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function csvCell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function FrequencyHistory() {
  const events = useFrequencyHistoryStore(s => s.events);
  const loaded = useFrequencyHistoryStore(s => s.loaded);
  const inventory = useDeviceStore(s => s.inventory);
  const [sortKey, setSortKey] = useState<SortKey>('timestamp');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [origin, setOrigin] = useState<Origin>('ALL');
  const [search, setSearch] = useState('');

  // The receiver's inventory name where it has one, as elsewhere in the app.
  const deviceName = (deviceId: string | null) => {
    if (!deviceId) return '';
    const ip = deviceId.split(':')[0];
    return inventory.find(d => d.ip === ip)?.name || ip;
  };
  const channelName = (e: FrequencyChangeEvent) => e.channelName || 'Unnamed channel';

  const filtered = useMemo(() => {
    let list = origin === 'ALL' ? events : events.filter(e => e.type === origin);

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(e =>
        channelName(e).toLowerCase().includes(q) ||
        formatFreq(e.toKHz).includes(q) ||
        formatFreq(e.fromKHz).includes(q));
    }

    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'timestamp') cmp = a.timestamp.localeCompare(b.timestamp);
      else if (sortKey === 'channelName') cmp = channelName(a).localeCompare(channelName(b));
      else if (sortKey === 'toKHz') cmp = a.toKHz - b.toKHz;
      else if (sortKey === 'delta') cmp = Math.abs(a.toKHz - a.fromKHz) - Math.abs(b.toKHz - b.fromKHz);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [events, origin, search, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  const SortIcon = ({ k }: { k: SortKey }) =>
    sortKey === k ? (sortDir === 'desc' ? <ChevronDown size={12} /> : <ChevronUp size={12} />) : null;

  // Exactly the rows on screen, filters included.
  const handleExport = () => {
    const rows = [
      ['Timestamp', 'Channel', 'Device', 'Previous (MHz)', 'New (MHz)', 'Delta (MHz)', 'Changed by'],
      ...filtered.map(e => [
        e.timestamp,
        channelName(e),
        deviceName(e.deviceId),
        formatFreq(e.fromKHz),
        formatFreq(e.toKHz),
        formatDelta(e.fromKHz, e.toKHz),
        ORIGIN_LABEL[e.type],
      ]),
    ];
    const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `rfdeck-frequency-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fh-root">
      <div className="fh-toolbar">
        <div className="fh-toolbar-left">
          <input
            type="text"
            className="fh-search"
            placeholder="Filter by channel or frequency…"
            aria-label="Filter frequency history"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="fh-filter-pills" role="group" aria-label="Changed by">
            {(['ALL', 'FREQUENCY_CHANGE', 'FREQUENCY_SET'] as const).map(s => (
              <button
                key={s}
                className={`fh-pill ${origin === s ? 'active' : ''}`}
                aria-pressed={origin === s}
                onClick={() => setOrigin(s)}
              >
                {s === 'FREQUENCY_CHANGE' && <Radio size={11} />}
                {s === 'FREQUENCY_SET' && <SlidersHorizontal size={11} />}
                {s === 'ALL' ? 'All' : ORIGIN_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
        <div className="fh-toolbar-right">
          <span className="fh-count">{filtered.length} {filtered.length === 1 ? 'change' : 'changes'}</span>
          <button
            className="fh-action-btn"
            onClick={handleExport}
            disabled={filtered.length === 0}
            title="Export these changes as CSV"
            aria-label="Export frequency history as CSV"
          >
            <Download size={14} />
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="fh-empty">
          <History size={36} />
          <p>{!loaded ? 'Loading frequency history…'
              : events.length === 0 ? 'No frequency changes recorded' : 'No changes match the filter'}</p>
          {loaded && events.length === 0 && (
            <span>Every retune is recorded here, whether RFDeck sent it or someone changed it at the receiver.</span>
          )}
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
                <th className="fh-th sortable" onClick={() => handleSort('toKHz')}>
                  New <SortIcon k="toKHz" />
                </th>
                <th className="fh-th sortable" onClick={() => handleSort('delta')}>
                  Delta <SortIcon k="delta" />
                </th>
                <th className="fh-th">Changed by</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => {
                const delta = e.toKHz - e.fromKHz;
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
                      <span className="fh-ch-name">{channelName(e)}</span>
                      <span className="fh-device-id">{deviceName(e.deviceId)}</span>
                    </td>
                    <td className="fh-td fh-td-mono fh-prev-freq">
                      {formatFreq(e.fromKHz)}
                      <span className="fh-mhz-unit">MHz</span>
                    </td>
                    <td className="fh-td fh-td-mono fh-new-freq">
                      {formatFreq(e.toKHz)}
                      <span className="fh-mhz-unit">MHz</span>
                    </td>
                    <td className={`fh-td fh-td-mono fh-delta ${deltaClass}`}>
                      {formatDelta(e.fromKHz, e.toKHz)}
                    </td>
                    <td className="fh-td">
                      <span className={`fh-source-badge ${e.type === 'FREQUENCY_SET' ? 'manual' : 'telem'}`}>
                        {e.type === 'FREQUENCY_SET' ? <SlidersHorizontal size={10} /> : <Radio size={10} />}
                        {ORIGIN_LABEL[e.type]}
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
