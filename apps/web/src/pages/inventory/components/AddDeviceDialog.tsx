import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { X, Wifi, MapPin, PlusCircle, Search, Loader } from 'lucide-react';
import { useDeviceStore, DiscoveredDevice } from '../../../stores/deviceStore';
import './AddDeviceDialog.css';

interface Props {
  open: boolean;
  onClose: () => void;
}

const MANUFACTURERS = ['Sennheiser', 'Shure', 'Wisycom', 'Lectrosonics', 'Sony', 'Other'];
const LOCATIONS = ['Stage Left', 'Stage Right', 'FOH', 'Backstage', 'Monitors', 'Rack Room'];

export function AddDeviceDialog({ open, onClose }: Props) {
  const { addToInventory, discovered } = useDeviceStore();

  // Manual entry form state
  const [form, setForm] = useState({
    name: '',
    manufacturer: 'Sennheiser',
    model: '',
    ip: '',
    port: '443',
    location: 'Stage Left',
    notes: '',
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const updateForm = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError('');
  };

  const handleManualAdd = async () => {
    if (!form.name.trim()) { setError('Device name is required.'); return; }
    if (!form.ip.trim()) { setError('IP address is required.'); return; }
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(form.ip.trim())) {
      setError('Please enter a valid IP address (e.g. 192.168.1.10).');
      return;
    }

    setSaving(true);
    try {
      addToInventory({
        name: form.name.trim(),
        manufacturer: form.manufacturer,
        model: form.model.trim() || form.manufacturer + ' Device',
        ip: form.ip.trim(),
        port: parseInt(form.port, 10) || 443,
        location: form.location,
        notes: form.notes.trim(),
      });
      handleClose();
    } finally {
      setSaving(false);
    }
  };

  const handleAddDiscovered = (d: DiscoveredDevice) => {
    addToInventory({
      name: d.name,
      manufacturer: d.manufacturer,
      model: d.model,
      ip: d.ip,
      port: d.port,
      location: '',
      notes: '',
    });
    onClose();
  };

  const handleClose = () => {
    setForm({ name: '', manufacturer: 'Sennheiser', model: '', ip: '', port: '443', location: 'Stage Left', notes: '' });
    setError('');
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby="add-dialog-desc">
          <Dialog.Title className="dialog-title">
            <PlusCircle size={18} />
            Add Device to Inventory
          </Dialog.Title>
          <Dialog.Description id="add-dialog-desc" className="sr-only">
            Add a device by scanning the network or entering its details manually.
          </Dialog.Description>
          <Dialog.Close className="dialog-close" asChild>
            <button><X size={16} /></button>
          </Dialog.Close>

          <Tabs.Root defaultValue="manual" className="dialog-tabs">
            <Tabs.List className="tabs-list">
              <Tabs.Trigger value="discover" className="tab-trigger">
                <Search size={14} />
                Network Scan
                {discovered.length > 0 && (
                  <span className="tab-badge">{discovered.length}</span>
                )}
              </Tabs.Trigger>
              <Tabs.Trigger value="manual" className="tab-trigger">
                <MapPin size={14} />
                Manual Entry
              </Tabs.Trigger>
            </Tabs.List>

            {/* ── Discover Tab ── */}
            <Tabs.Content value="discover" className="tab-content">
              {discovered.length === 0 ? (
                <div className="discover-empty">
                  <Loader size={32} className="discover-spinner" />
                  <p className="discover-empty-title">Scanning network for devices…</p>
                  <p className="discover-empty-desc">
                    Devices advertising via mDNS / Bonjour will appear here automatically. Make sure your hardware is powered on and connected to the same network.
                  </p>
                </div>
              ) : (
                <div className="discovered-list">
                  {discovered.map((d) => (
                    <div key={d.key} className="discovered-item">
                      <div className="discovered-info">
                        <Wifi size={16} className="discovered-icon" />
                        <div>
                          <div className="discovered-name">{d.name}</div>
                          <div className="discovered-meta">{d.manufacturer} · {d.model} · {d.ip}:{d.port}</div>
                        </div>
                      </div>
                      <button className="btn-add-discovered" onClick={() => handleAddDiscovered(d)}>
                        Add
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Tabs.Content>

            {/* ── Manual Tab ── */}
            <Tabs.Content value="manual" className="tab-content">
              <div className="form-grid">
                <div className="form-field form-field-full">
                  <label className="form-label">Device Name *</label>
                  <input
                    className="form-input"
                    placeholder="e.g. Stage Left Rack A"
                    value={form.name}
                    onChange={(e) => updateForm('name', e.target.value)}
                  />
                </div>

                <div className="form-field">
                  <label className="form-label">Manufacturer</label>
                  <div className="select-wrap">
                    <select
                      className="form-select"
                      value={form.manufacturer}
                      onChange={(e) => updateForm('manufacturer', e.target.value)}
                    >
                      {MANUFACTURERS.map((m) => <option key={m}>{m}</option>)}
                    </select>
                  </div>
                </div>

                <div className="form-field">
                  <label className="form-label">Model</label>
                  <input
                    className="form-input"
                    placeholder="e.g. EW-DX EM 2"
                    value={form.model}
                    onChange={(e) => updateForm('model', e.target.value)}
                  />
                </div>

                <div className="form-field">
                  <label className="form-label">IP Address *</label>
                  <input
                    className="form-input"
                    placeholder="e.g. 192.168.1.10"
                    value={form.ip}
                    onChange={(e) => updateForm('ip', e.target.value)}
                  />
                </div>

                <div className="form-field">
                  <label className="form-label">Port</label>
                  <input
                    className="form-input"
                    placeholder="443"
                    value={form.port}
                    onChange={(e) => updateForm('port', e.target.value)}
                  />
                </div>

                <div className="form-field">
                  <label className="form-label">Location</label>
                  <div className="select-wrap">
                    <select
                      className="form-select"
                      value={form.location}
                      onChange={(e) => updateForm('location', e.target.value)}
                    >
                      {LOCATIONS.map((l) => <option key={l}>{l}</option>)}
                    </select>
                  </div>
                </div>

                <div className="form-field form-field-full">
                  <label className="form-label">Notes <span className="label-optional">(optional)</span></label>
                  <textarea
                    className="form-textarea"
                    placeholder="Any notes about this device..."
                    rows={3}
                    value={form.notes}
                    onChange={(e) => updateForm('notes', e.target.value)}
                  />
                </div>
              </div>

              {error && <div className="form-error">{error}</div>}

              <div className="dialog-footer">
                <button className="btn-ghost" onClick={handleClose}>Cancel</button>
                <button className="btn-primary-dialog" onClick={handleManualAdd} disabled={saving}>
                  {saving ? <Loader size={14} className="btn-spinner" /> : <PlusCircle size={14} />}
                  Add to Inventory
                </button>
              </div>
            </Tabs.Content>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
