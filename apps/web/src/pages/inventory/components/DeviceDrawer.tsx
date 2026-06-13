import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  X, Wifi, WifiOff, Radio, MapPin, Info, Network,
  Cpu, Trash2, Activity, Zap
} from 'lucide-react';
import { InventoryDevice, useDeviceStore } from '../../../stores/deviceStore';
import { useSocket } from '../../../hooks/useSocket';
import './DeviceDrawer.css';

interface Props {
  device: InventoryDevice | null;
  onClose: () => void;
}

export function DeviceDrawer({ device, onClose }: Props) {
  const { removeFromInventory } = useDeviceStore();
  const { socket, isConnected } = useSocket();

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
                <Dialog.Close className="drawer-close" asChild>
                  <button><X size={18} /></button>
                </Dialog.Close>
              </div>

              {/* Online Status Banner */}
              <div className={`status-banner ${device.online ? 'online' : 'offline'}`}>
                {device.online ? <Wifi size={14} /> : <WifiOff size={14} />}
                <span>{device.online ? 'Device Online' : 'Device Offline / Unreachable'}</span>
                {device.online && device.channelCount != null && (
                  <span className="banner-channels">
                    {device.activeChannelCount ?? 0}/{device.channelCount} channels active
                  </span>
                )}
              </div>

              {/* Scrollable body */}
              <div className="drawer-body">

                {/* Identity */}
                <DrawerSection title="Identity" icon={<Info size={14} />}>
                  <DrawerRow label="Name" value={device.name} />
                  <DrawerRow label="Manufacturer" value={device.manufacturer} />
                  <DrawerRow label="Model" value={device.model} />
                  {device.serial && <DrawerRow label="Serial" value={device.serial} mono />}
                  {device.mac && <DrawerRow label="MAC Address" value={device.mac} mono />}
                </DrawerSection>

                {/* Network */}
                <DrawerSection title="Network Configuration" icon={<Network size={14} />}>
                  <DrawerRow label="IP Address" value={device.ip} mono highlight />
                  <DrawerRow label="Port" value={String(device.port)} mono />
                  <DrawerRow label="Location" value={device.location || '—'} />
                  
                  <div className="network-edit mt-4" style={{ marginTop: '16px', display: 'flex', gap: '8px' }}>
                    <input type="text" id="net-ip" placeholder="Static IP" className="drawer-input" style={{ flex: 1 }} defaultValue={device.ip} />
                    <input type="text" id="net-sub" placeholder="Subnet" className="drawer-input" style={{ width: '80px' }} defaultValue="255.255.255.0" />
                    <input type="text" id="net-gw" placeholder="Gateway" className="drawer-input" style={{ width: '100px' }} defaultValue="192.168.1.1" />
                    <button 
                      className="btn-primary-sm" 
                      onClick={() => {
                        const ip = (document.getElementById('net-ip') as HTMLInputElement).value;
                        const sub = (document.getElementById('net-sub') as HTMLInputElement).value;
                        const gw = (document.getElementById('net-gw') as HTMLInputElement).value;
                        if (device && socket && isConnected) {
                          socket.emit('device:network', { 
                            deviceId: `${device.ip}:${device.port}`,
                            staticIp: ip,
                            subnet: sub,
                            gateway: gw
                          });
                        }
                      }}
                    >
                      Save
                    </button>
                  </div>
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
