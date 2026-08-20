import React, { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  X, Wifi, WifiOff, Radio, Info, Network,
  Cpu, Trash2, Activity, Zap, Headphones, Pencil, Check, Ban, Mic, PowerOff
} from 'lucide-react';
import { InventoryDevice, useDeviceStore } from '../../../stores/deviceStore';
import { useSocket } from '../../../hooks/useSocket';
import { useAudioStore } from '../../../stores/audioStore';
import { useChannelStore } from '../../../stores/channelStore';
import './DeviceDrawer.css';

interface Props {
  device: InventoryDevice | null;
  onClose: () => void;
}

export function DeviceDrawer({ device, onClose }: Props) {
  const { removeFromInventory, updateInventoryDevice, setDeviceActive } = useDeviceStore();
  const { socket, isConnected } = useSocket();
  const { channelAssignments, assignChannelToInput, selectedDeviceId } = useAudioStore();
  const channels = useChannelStore((s) => s.channels.filter(c => device && c.deviceId.startsWith(device.ip)));

  const [isEditing, setIsEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftLocation, setDraftLocation] = useState('');
  const [draftIp, setDraftIp] = useState('');
  const [draftPort, setDraftPort] = useState('');
  const [draftPassword, setDraftPassword] = useState('');
  const [draftDeviceType, setDraftDeviceType] = useState<'input' | 'output'>('input');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (device) {
      setDraftName(device.name);
      setDraftLocation(device.location ?? '');
      setDraftIp(device.ip);
      setDraftPort(String(device.port));
      setDraftPassword('');
      setDraftDeviceType(device.deviceType ?? 'input');
      setIsEditing(false);
    }
  }, [device?.id]);

  const handleRemove = () => {
    if (device && window.confirm(`Remove "${device.name}" from inventory?`)) {
      removeFromInventory(device.id);
      onClose();
    }
  };

  const handleIdentify = () => {
    if (device && socket && isConnected) {
      socket.emit('device:identify', { deviceId: `${device.ip}:${device.port}` });
    }
  };

  const cancelEdit = () => {
    if (!device) return;
    setDraftName(device.name);
    setDraftLocation(device.location ?? '');
    setDraftIp(device.ip);
    setDraftPort(String(device.port));
    setDraftPassword('');
    setDraftDeviceType(device.deviceType ?? 'input');
    setIsEditing(false);
  };

  const handleSave = async () => {
    if (!device) return;
    const portNum = parseInt(draftPort, 10);
    if (draftIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(draftIp.trim())) return;
    setSaving(true);
    const update: Record<string, any> = {
      name: draftName.trim() || device.name,
      location: draftLocation.trim() || undefined,
      ip: draftIp.trim() || device.ip,
      port: isNaN(portNum) ? device.port : portNum,
      deviceType: draftDeviceType,
    };
    // Only include password if the user typed something; blank = keep existing
    if (draftPassword.trim()) update.password = draftPassword.trim();
    await updateInventoryDevice(device.id, update);
    setSaving(false);
    setIsEditing(false);
  };

  return (
    <Dialog.Root open={!!device} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-overlay" />
        <Dialog.Content className="drawer-content" aria-describedby="drawer-description">
          <Dialog.Description id="drawer-description" className="sr-only">
            Device details and configuration for {device?.name}
          </Dialog.Description>

          {device && (
            <>
              {/* Header */}
              <div className="drawer-header">
                <div className="drawer-header-left">
                  <div
                    className="status-dot"
                    style={{
                      background: device.online ? 'var(--color-success)' : 'var(--color-error)',
                      boxShadow: device.online
                        ? '0 0 8px rgba(107, 255, 143, 0.6)'
                        : '0 0 8px rgba(255, 180, 171, 0.4)',
                    }}
                  />
                  <div>
                    <Dialog.Title className="drawer-title">{device.name}</Dialog.Title>
                    <p className="drawer-subtitle">{device.manufacturer} · {device.model}</p>
                  </div>
                </div>
                <div className="drawer-header-actions">
                  {!isEditing ? (
                    <button className="drawer-icon-btn" onClick={() => setIsEditing(true)} title="Edit device">
                      <Pencil size={15} />
                    </button>
                  ) : (
                    <button className="drawer-icon-btn danger" onClick={cancelEdit} title="Cancel">
                      <Ban size={15} />
                    </button>
                  )}
                  <Dialog.Close className="drawer-close" asChild>
                    <button><X size={18} /></button>
                  </Dialog.Close>
                </div>
              </div>

              {/* Active / Inactive toggle — an inactive device is intentionally
                  powered off, so it is not tracked and raises no alerts. */}
              <div className={`active-toggle-bar ${device.active === false ? 'is-inactive' : ''}`}>
                <div className="active-toggle-text">
                  <span className="active-toggle-title">
                    {device.active === false ? 'Inactive' : 'Active'}
                  </span>
                  <span className="active-toggle-desc">
                    {device.active === false
                      ? 'Not monitored — hidden from dashboard, no alerts'
                      : 'Monitored on the dashboard and alert log'}
                  </span>
                </div>
                <button
                  className={`active-switch ${device.active === false ? 'off' : 'on'}`}
                  role="switch"
                  aria-checked={device.active !== false}
                  onClick={() => setDeviceActive(device.id, device.active === false)}
                  title={device.active === false ? 'Set active' : 'Set inactive'}
                >
                  <span className="active-switch-knob" />
                </button>
              </div>

              {/* Online Status Banner — only meaningful for active devices */}
              {device.active === false ? (
                <div className="status-banner inactive">
                  <PowerOff size={14} />
                  <span>Device set inactive — monitoring paused</span>
                </div>
              ) : (
                <div className={`status-banner ${device.online ? 'online' : 'offline'}`}>
                  {device.online ? <Wifi size={14} /> : <WifiOff size={14} />}
                  <span>{device.online ? 'Device Online' : 'Device Offline / Unreachable'}</span>
                  {device.online && device.channelCount != null && (
                    <span className="banner-channels">
                      {device.activeChannelCount ?? 0}/{device.channelCount} channels active
                    </span>
                  )}
                </div>
              )}

              {/* Scrollable body */}
              <div className="drawer-body">

                {/* Identity */}
                <DrawerSection title="Identity" icon={<Info size={14} />}>
                  {isEditing ? (
                    <>
                      <div className="drawer-row">
                        <span className="drawer-row-label">Name</span>
                        <input
                          className="drawer-input drawer-edit-input"
                          value={draftName}
                          onChange={e => setDraftName(e.target.value)}
                          placeholder="Device name"
                        />
                      </div>
                      <div className="drawer-row">
                        <span className="drawer-row-label">Type</span>
                        <div className="drawer-type-toggle">
                          <button
                            className={`drawer-type-btn ${draftDeviceType === 'input' ? 'active' : ''}`}
                            onClick={() => setDraftDeviceType('input')}
                          >
                            <Mic size={12} /> Input
                          </button>
                          <button
                            className={`drawer-type-btn ${draftDeviceType === 'output' ? 'active' : ''}`}
                            onClick={() => setDraftDeviceType('output')}
                          >
                            <Headphones size={12} /> Output (IEM)
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <DrawerRow label="Name" value={device.name} />
                      <DrawerRow
                        label="Type"
                        value={device.deviceType === 'output' ? 'Output (IEM / Monitor)' : 'Input (Mic / Instrument)'}
                      />
                    </>
                  )}
                  <DrawerRow label="Manufacturer" value={device.manufacturer} />
                  <DrawerRow label="Model" value={device.model} />
                  {device.serial && <DrawerRow label="Serial" value={device.serial} mono />}
                  {device.mac && <DrawerRow label="MAC Address" value={device.mac} mono />}
                </DrawerSection>

                {/* Network */}
                <DrawerSection title="Connection" icon={<Network size={14} />}>
                  {isEditing ? (
                    <>
                      <div className="drawer-row">
                        <span className="drawer-row-label">IP Address</span>
                        <input
                          className="drawer-input drawer-edit-input"
                          value={draftIp}
                          onChange={e => setDraftIp(e.target.value)}
                          placeholder="e.g. 192.168.1.10"
                        />
                      </div>
                      <div className="drawer-row">
                        <span className="drawer-row-label">Port</span>
                        <input
                          className="drawer-input drawer-edit-input"
                          value={draftPort}
                          onChange={e => setDraftPort(e.target.value)}
                          placeholder="443"
                          style={{ width: '80px' }}
                        />
                      </div>
                      <div className="drawer-row">
                        <span className="drawer-row-label">Location</span>
                        <input
                          className="drawer-input drawer-edit-input"
                          value={draftLocation}
                          onChange={e => setDraftLocation(e.target.value)}
                          placeholder="e.g. Stage Left"
                        />
                      </div>
                      {device.manufacturer === 'Sennheiser' && (
                        <div className="drawer-row">
                          <span className="drawer-row-label">Password</span>
                          <input
                            type="password"
                            className="drawer-input drawer-edit-input"
                            value={draftPassword}
                            onChange={e => setDraftPassword(e.target.value)}
                            placeholder={device.hasPassword ? '●●●● (set — leave blank to keep)' : 'No password'}
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <DrawerRow label="IP Address" value={device.ip} mono highlight />
                      <DrawerRow label="Port" value={String(device.port)} mono />
                      <DrawerRow label="Location" value={device.location || '—'} />
                    </>
                  )}
                </DrawerSection>

                {/* Audio Input Assignment */}
                <DrawerSection title="Audio Inputs" icon={<Headphones size={14} />}>
                  {!selectedDeviceId ? (
                    <p className="drawer-section-desc">
                      No audio interface selected. Configure one in Settings → Audio Device.
                    </p>
                  ) : channels.length === 0 ? (
                    <p className="drawer-section-desc">
                      {device.online ? 'Waiting for channel data from device…' : 'Device offline — connect to assign audio inputs.'}
                    </p>
                  ) : (
                    <div className="audio-assignments">
                      {channels.map(ch => (
                        <div key={ch.id} className="audio-assignment-row">
                          <span className="drawer-row-label">{ch.name || `Channel ${ch.channelIndex}`}</span>
                          <select
                            className="drawer-input audio-input-select"
                            value={channelAssignments[ch.id] ?? ''}
                            onChange={e => assignChannelToInput(ch.id, e.target.value === '' ? null : parseInt(e.target.value, 10))}
                          >
                            <option value="">— Not assigned —</option>
                            {Array.from({ length: 16 }, (_, i) => (
                              <option key={i + 1} value={i + 1}>Input {i + 1}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  )}
                </DrawerSection>

                {/* Firmware */}
                {device.firmware && (
                  <DrawerSection title="Firmware" icon={<Cpu size={14} />}>
                    <DrawerRow label="Version" value={device.firmware} mono />
                    <div className="fw-check-row">
                      <button className="btn-text-primary">Check for Updates</button>
                    </div>
                  </DrawerSection>
                )}

                {/* Live Stats (if online) */}
                {device.online && (
                  <DrawerSection title="Live Status" icon={<Activity size={14} />}>
                    <DrawerRow
                      label="Channels Active"
                      value={`${device.activeChannelCount ?? 0} / ${device.channelCount ?? '?'}`}
                      mono
                    />
                  </DrawerSection>
                )}

                {/* Notes */}
                {device.notes && (
                  <DrawerSection title="Notes" icon={<Info size={14} />}>
                    <p className="notes-text">{device.notes}</p>
                  </DrawerSection>
                )}

                {/* Added timestamp */}
                <div className="drawer-added">
                  Added {new Date(device.addedAt).toLocaleDateString('en-US', {
                    year: 'numeric', month: 'long', day: 'numeric'
                  })}
                </div>
              </div>

              {/* Actions Footer */}
              <div className="drawer-footer">
                {isEditing ? (
                  <>
                    <button className="btn-secondary-sm" onClick={cancelEdit}>
                      Cancel
                    </button>
                    <div className="footer-actions-right">
                      <button className="btn-primary-sm" onClick={handleSave} disabled={saving}>
                        <Check size={14} />
                        {saving ? 'Saving…' : 'Save Changes'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <button className="btn-secondary-sm" onClick={handleRemove}>
                      <Trash2 size={14} />
                      Remove
                    </button>
                    <div className="footer-actions-right">
                      <button className="btn-secondary-sm" onClick={handleIdentify} disabled={!device.online}>
                        <Zap size={14} />
                        Identify
                      </button>
                      <button className="btn-primary-sm">
                        <Radio size={14} />
                        View Channels
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DrawerSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="drawer-section">
      <div className="section-header">
        {icon}
        <span className="section-title">{title}</span>
      </div>
      <div className="section-divider" />
      <div className="section-body">{children}</div>
    </div>
  );
}

function DrawerRow({ label, value, mono, highlight }: {
  label: string; value: string; mono?: boolean; highlight?: boolean;
}) {
  return (
    <div className="drawer-row">
      <span className="drawer-row-label">{label}</span>
      <span className={`drawer-row-value ${mono ? 'mono' : ''} ${highlight ? 'highlight' : ''}`}>
        {value}
      </span>
    </div>
  );
}
