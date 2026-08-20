import React, { useState } from 'react';
import { Channel } from '@rfdeck/shared-types';
import { ArrowUpDown, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';

interface Props {
  channels: Channel[];
}

type SortKey = 'name' | 'frequency' | 'rfLevelA' | 'status';

const STATUS_ICON = {
  ACTIVE: <CheckCircle size={13} color="var(--color-success)" />,
  WARNING: <AlertTriangle size={13} color="#ff8c42" />,
  CRITICAL: <XCircle size={13} color="var(--color-error)" />,
};

const STATUS_LABEL = {
  ACTIVE: 'Active',
  WARNING: 'Warning',
  CRITICAL: 'Critical',
};

export function FrequencyTable({ channels }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('frequency');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sorted = [...channels].sort((a, b) => {
    let av: string | number, bv: string | number;
    if (sortKey === 'name') { av = a.name; bv = b.name; }
    else if (sortKey === 'frequency') { av = a.frequency; bv = b.frequency; }
    else if (sortKey === 'rfLevelA') { av = a.rfLevelA; bv = b.rfLevelA; }
    else { av = a.status; bv = b.status; }
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  if (channels.length === 0) {
    return (
      <div className="freq-table-empty">
        <p>No active channels. Connect to hardware to see live frequency data.</p>
      </div>
    );
  }

  return (
    <div className="freq-table-wrapper">
      <table className="freq-table">
        <thead>
          <tr>
            <SortTh label="Channel" sortKey="name" current={sortKey} dir={sortDir} onSort={toggleSort} />
            <SortTh label="Frequency (MHz)" sortKey="frequency" current={sortKey} dir={sortDir} onSort={toggleSort} />
            <th className="th">Device</th>
            <SortTh label="RF Level" sortKey="rfLevelA" current={sortKey} dir={sortDir} onSort={toggleSort} />
            <SortTh label="Status" sortKey="status" current={sortKey} dir={sortDir} onSort={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((ch) => (
            <tr key={ch.id} className={`freq-row ${ch.status.toLowerCase()}`}>
              <td className="td td-name">{ch.name || `CH ${ch.channelIndex}`}</td>
              <td className="td td-freq">{(ch.frequency / 1000).toFixed(3)}</td>
              <td className="td td-device">{ch.deviceId.split(':')[0]}</td>
              <td className="td td-rf">
                <div className="rf-bar-wrap">
                  <div
                    className="rf-bar"
                    style={{
                      width: `${ch.rfLevelA}%`,
                      background: ch.rfLevelA > 70
                        ? 'var(--color-success)'
                        : ch.rfLevelA > 40
                        ? '#ff8c42'
                        : 'var(--color-error)',
                    }}
                  />
                  <span className="rf-bar-label">{Math.round(ch.rfLevelA)}%</span>
                </div>
              </td>
              <td className="td td-status">
                <span className={`status-chip status-${ch.status.toLowerCase()}`}>
                  {STATUS_ICON[ch.status]}
                  {STATUS_LABEL[ch.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortTh({ label, sortKey, current, dir, onSort }: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: 'asc' | 'desc';
  onSort: (k: SortKey) => void;
}) {
  const active = current === sortKey;
  return (
    <th className={`th th-sortable ${active ? 'active' : ''}`} onClick={() => onSort(sortKey)}>
      {label}
      <ArrowUpDown size={11} className={`sort-icon ${active ? 'visible' : ''}`} />
    </th>
  );
}
