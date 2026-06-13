import React from 'react';
import { CheckCircle, XCircle } from 'lucide-react';
import { InventoryDevice } from '../../../stores/deviceStore';
import './HardwareCard.css';


interface Props {
  device: InventoryDevice;
  viewMode: 'grid' | 'list';
  onClick: () => void;
}

export function HardwareCard({ device, viewMode, onClick }: Props) {
  const statusColor = device.online ? 'var(--color-success)' : 'var(--color-error)';
  const borderColor = device.online
    ? 'rgba(107, 255, 143, 0.2)'
    : 'rgba(255, 180, 171, 0.2)';
  const topBarColor = device.online ? 'var(--color-success)' : 'var(--color-error)';

  if (viewMode === 'list') {
    return (
      <div
        className="hardware-list-row"
        onClick={onClick}
        style={{ borderLeft: `3px solid ${topBarColor}` }}
      >
        <div className="list-row-status">
          {device.online ? (
            <CheckCircle size={16} color="var(--color-success)" />
          ) : (
            <XCircle size={16} color="var(--color-error)" />
          )}
        </div>
        <div className="list-row-name">
          <span className="card-name">{device.name}</span>
          <span className="card-model">{device.manufacturer} · {device.model}</span>
        </div>
        <div className="list-row-ip">
          <span className="mono-dim">{device.ip}</span>
        </div>
        <div className="list-row-location">
          <span className="tag">{device.location || '—'}</span>
        </div>
        <div className="list-row-channels">
          {device.online && device.channelCount != null ? (
            <span className="mono-bright">{device.activeChannelCount ?? 0} / {device.channelCount} ch</span>
          ) : (
            <span className="mono-dim">—</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="hardware-card"
      onClick={onClick}
      style={{ borderColor, '--top-bar': topBarColor } as React.CSSProperties}
    >
      {/* Status bar */}
      <div className="card-top-bar" style={{ background: topBarColor }} />

      <div className="card-body">
        <div className="card-header">
          <div>
            <h3 className="card-name">{device.name}</h3>
            <p className="card-model">{device.manufacturer} · {device.model}</p>
          </div>
          {device.online ? (
            <CheckCircle size={18} color="var(--color-success)" />
          ) : (
            <XCircle size={18} color="var(--color-error)" />
          )}
        </div>

        <div className="card-meta">
          <div className="meta-row">
            <span className="meta-label">IP Address</span>
            <span className="meta-value mono">{device.ip}</span>
          </div>
          <div className="meta-row">
            <span className="meta-label">Location</span>
            <span className="meta-value">{device.location || '—'}</span>
          </div>
          {device.online && device.channelCount != null && (
            <div className="meta-row">
              <span className="meta-label">Channels</span>
              <span className="meta-value mono">
                {device.activeChannelCount ?? 0} / {device.channelCount} Active
              </span>
            </div>
          )}
        </div>

        {device.firmware && (
          <div className="card-firmware">
            <span className="firmware-label">FW {device.firmware}</span>
          </div>
        )}
      </div>
    </div>
  );
}
