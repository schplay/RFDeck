import React from 'react';
import { CheckCircle, XCircle, PowerOff, Ban } from 'lucide-react';
import { InventoryDevice } from '../../../stores/deviceStore';
import './HardwareCard.css';


interface Props {
  device: InventoryDevice;
  viewMode: 'grid' | 'list';
  onClick: () => void;
  onToggleActive: () => void;
}

export function HardwareCard({ device, viewMode, onClick, onToggleActive }: Props) {
  // Inactive devices are intentionally powered off — show them as dimmed/neutral
  // rather than as an error state, so real offline faults still stand out.
  const isInactive = device.active === false;
  // Reachable but refusing the password: a third state between online and
  // offline. Shown as a warning rather than green, because green sent the
  // operator to the dashboard looking for cards that could never appear.
  const authFailed = !isInactive && device.online && !!device.authFailed;
  const borderColor = isInactive
    ? 'rgba(132, 148, 149, 0.2)'
    : authFailed
      ? 'rgba(217, 119, 6, 0.3)'
      : device.online
        ? 'rgba(107, 255, 143, 0.2)'
        : 'rgba(255, 180, 171, 0.2)';
  const topBarColor = isInactive
    ? 'var(--color-on-surface-variant)'
    : authFailed
      ? 'var(--color-warning, #d97706)'
      : device.online ? 'var(--color-success)' : 'var(--color-error)';

  const StatusIcon = isInactive ? (
    <PowerOff size={16} color="var(--color-on-surface-variant)" />
  ) : authFailed ? (
    <Ban size={16} color="var(--color-warning, #d97706)" />
  ) : device.online ? (
    <CheckCircle size={16} color="var(--color-success)" />
  ) : (
    <XCircle size={16} color="var(--color-error)" />
  );

  // Inline active switch. stopPropagation keeps a toggle click from also
  // opening the device drawer behind it.
  const ActiveSwitch = (
    <button
      className={`card-active-switch ${isInactive ? 'off' : 'on'}`}
      role="switch"
      aria-checked={!isInactive}
      aria-label={isInactive ? `Activate ${device.name}` : `Deactivate ${device.name}`}
      title={isInactive ? 'Set active' : 'Set inactive'}
      onClick={(e) => { e.stopPropagation(); onToggleActive(); }}
    >
      <span className="card-active-knob" />
    </button>
  );

  if (viewMode === 'list') {
    return (
      <div
        className={`hardware-list-row ${isInactive ? 'is-inactive' : ''}`}
        onClick={onClick}
        style={{ borderLeft: `3px solid ${topBarColor}` }}
      >
        <div className="list-row-status">{StatusIcon}</div>
        <div className="list-row-name">
          <span className="card-name">
            {device.name}
            {isInactive && <span className="inactive-tag">Inactive</span>}
            {authFailed && <span className="auth-tag" title={device.authFailed ?? undefined}>Password refused</span>}
          </span>
          <span className="card-model">{device.manufacturer} · {device.model}</span>
        </div>
        <div className="list-row-ip">
          <span className="mono-dim">{device.ip}</span>
        </div>
        <div className="list-row-location">
          <span className="tag">{device.location || '—'}</span>
        </div>
        <div className="list-row-channels">
          {!isInactive && device.online && device.channelCount != null ? (
            <span className="mono-bright">{device.activeChannelCount ?? 0} / {device.channelCount} ch</span>
          ) : (
            <span className="mono-dim">—</span>
          )}
        </div>
        <div className="list-row-toggle">{ActiveSwitch}</div>
      </div>
    );
  }

  return (
    <div
      className={`hardware-card ${isInactive ? 'is-inactive' : ''}`}
      onClick={onClick}
      style={{ borderColor, '--top-bar': topBarColor } as React.CSSProperties}
    >
      {/* Status bar */}
      <div className="card-top-bar" style={{ background: topBarColor }} />

      <div className="card-body">
        <div className="card-header">
          <div>
            <h3 className="card-name">
              {device.name}
              {isInactive && <span className="inactive-tag">Inactive</span>}
            {authFailed && <span className="auth-tag" title={device.authFailed ?? undefined}>Password refused</span>}
            </h3>
            <p className="card-model">{device.manufacturer} · {device.model}</p>
          </div>
          {StatusIcon}
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
          {!isInactive && device.online && device.channelCount != null && (
            <div className="meta-row">
              <span className="meta-label">Channels</span>
              <span className="meta-value mono">
                {device.activeChannelCount ?? 0} / {device.channelCount} Active
              </span>
            </div>
          )}
        </div>

        <div className="card-footer">
          {device.firmware ? (
            <span className="firmware-label">FW {device.firmware}</span>
          ) : (
            <span />
          )}
          <div className="card-footer-toggle">
            <span className="card-toggle-label">{isInactive ? 'Inactive' : 'Active'}</span>
            {ActiveSwitch}
          </div>
        </div>
      </div>
    </div>
  );
}
