import React, { useState, useEffect, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { X, Wifi, MapPin, PlusCircle, Search, Loader, Mic, Headphones, ListPlus, RefreshCw } from 'lucide-react';
import { useDeviceStore, DiscoveredDevice } from '../../../stores/deviceStore';
import { useSocket } from '../../../hooks/useSocket';
import { API_BASE } from '../../../lib/api';
import './AddDeviceDialog.css';

interface Props {
  open: boolean;
  onClose: () => void;
}

const MANUFACTURERS = ['Sennheiser', 'Shure', 'Wisycom', 'Lectrosonics', 'Sony', 'Other'];
const LOCATIONS = ['Stage Left', 'Stage Right', 'FOH', 'Backstage', 'Monitors', 'Rack Room'];

// Shure receivers RFDeck can talk to, and what each one implies.
//
// The model is load-bearing here in a way it is not for other manufacturers:
// it selects the command vocabulary — Axient's TX_BATT_BARS against ULX-D's
// BATT_BARS — and the number of channels to poll. A wrong choice produces a
// receiver that connects and then reports nothing, which is the least
// diagnosable failure there is, so this is a list rather than a text field.
const SHURE_MODELS = [
  { value: 'AD4D',   label: 'Axient Digital AD4D — 2 channel' },
  { value: 'AD4Q',   label: 'Axient Digital AD4Q — 4 channel' },
  { value: 'ULXD4',  label: 'ULX-D ULXD4 — 1 channel' },
  { value: 'ULXD4D', label: 'ULX-D ULXD4D — 2 channel' },
  { value: 'ULXD4Q', label: 'ULX-D ULXD4Q — 4 channel' },
  { value: 'QLXD4',  label: 'QLX-D QLXD4 — 1 channel' },
  { value: 'SLXD4',  label: 'SLX-D SLXD4 — 1 channel' },
  { value: 'SLXD4D', label: 'SLX-D SLXD4D — 2 channel' },
];

// What each manufacturer's default port is, and what RFDeck can actually do
// with it. The hints say plainly where support does not exist — an operator
// who adds a device that will never connect deserves to find that out here
// rather than from a card that stays grey all night.
const MANUFACTURER_PORT_HINTS: Record<string, { port: number; hint: string }> = {
  Sennheiser:   { port: 443,  hint: 'EW-DX (firmware ≥ 4.0) — port 443 (HTTPS SSCv2). G3/G4 are found automatically. Digital 6000 (EM 6000) is not yet supported: it uses SSC over UDP 6970.' },
  Shure:        { port: 2202, hint: 'Axient Digital / ULX-D / QLX-D / SLX-D — port 2202' },
  Wisycom:      { port: 2101, hint: 'Not yet supported. MRK receivers use Ember+; the tree layout is undocumented.' },
  Lectrosonics: { port: 4080, hint: 'Not yet supported. Lectrosonics publishes the port but not the protocol.' },
  Sony:         { port: 443,  hint: 'Not supported. Sony publishes no third-party control protocol for DWX.' },
  Other:        { port: 80,   hint: 'Check your device manual for the correct API port' },
};

interface DiscoverAddForm {
  location: string;
  deviceType: 'input' | 'output';
  password: string;
}

const needsAddForm = (d: DiscoveredDevice) =>
  d.manufacturer === 'Sennheiser' || d.port === 443;

export function AddDeviceDialog({ open, onClose }: Props) {
  const { addToInventory, discovered } = useDeviceStore();
  const { socket } = useSocket();

  const [hasDefaultPassword, setHasDefaultPassword] = useState(false);
  const [addingAll, setAddingAll] = useState(false);
  const [scanning, setScanning] = useState(false);

  const triggerScan = useCallback(() => {
    setScanning(true);
    fetch(`${API_BASE}/discovery/scan`, { method: 'POST' }).catch(() => {});
  }, []);

  // Manual entry form state
  const [form, setForm] = useState({
    name: '',
    manufacturer: 'Sennheiser',
    model: '',
    ip: '',
    port: '443',
    location: 'Stage Left',
    notes: '',
    password: '',
    deviceType: 'input' as 'input' | 'output',
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Discovered tab: tracks which device is showing its inline add-form
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [discoverForm, setDiscoverForm] = useState<DiscoverAddForm>({
    location: 'Stage Left',
    deviceType: 'input',
    password: '',
  });

  // Find out whether a default password is configured, and kick off a network
  // scan, whenever the dialog opens.
  //
  // We only learn *that* one exists, not what it is — it unlocks the wireless
  // hardware and stays server-side. Leaving the password field blank makes the
  // server apply the default when it creates the device.
  useEffect(() => {
    if (!open) return;
    fetch(`${API_BASE}/settings`)
      .then((r) => r.json())
      .then((s) => setHasDefaultPassword(!!s.hasDefaultPassword))
      .catch(() => {});

    triggerScan();
  }, [open, triggerScan]);

  // Track scan progress via socket events
  useEffect(() => {
    if (!socket) return;
    const onStart    = () => setScanning(true);
    const onComplete = () => setScanning(false);
    socket.on('discovery:scan-start',    onStart);
    socket.on('discovery:scan-complete', onComplete);
    return () => {
      socket.off('discovery:scan-start',    onStart);
      socket.off('discovery:scan-complete', onComplete);
    };
  }, [socket]);

  const updateForm = (key: keyof typeof form, value: string) => {
    if (key === 'manufacturer') {
      const hint = MANUFACTURER_PORT_HINTS[value];
      setForm((f) => ({
        ...f,
        manufacturer: value,
        port: String(hint?.port ?? f.port),
      }));
    } else {
      setForm((f) => ({ ...f, [key]: value }));
    }
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
      await addToInventory({
        name: form.name.trim(),
        manufacturer: form.manufacturer,
        model: form.model.trim() || form.manufacturer + ' Device',
        ip: form.ip.trim(),
        port: parseInt(form.port, 10) || 443,
        location: form.location,
        notes: form.notes.trim(),
        password: form.password.trim() || undefined,
        deviceType: form.deviceType,
      });
      handleClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDiscoveredClick = (d: DiscoveredDevice) => {
    if (needsAddForm(d)) {
      setExpandedKey(expandedKey === d.key ? null : d.key);
      // Left blank: the server applies the configured default password.
      setDiscoverForm({ location: 'Stage Left', deviceType: 'input', password: '' });
    } else {
      addToInventory({
        name: d.name,
        manufacturer: d.manufacturer,
        model: d.model,
        ip: d.ip,
        port: d.port,
        location: '',
        notes: '',
        deviceType: 'input',
      });
      onClose();
    }
  };

  const handleDiscoveredConfirm = (d: DiscoveredDevice) => {
    addToInventory({
      name: d.name,
      manufacturer: d.manufacturer,
      model: d.model,
      ip: d.ip,
      port: d.port,
      location: discoverForm.location,
      notes: '',
      password: discoverForm.password.trim() || undefined,
      deviceType: discoverForm.deviceType,
    });
    onClose();
  };

  // Add every discovered device at once using the default password for SSC devices
  const handleAddAll = async () => {
    setAddingAll(true);
    try {
      for (const d of discovered) {
        await addToInventory({
          name: d.name,
          manufacturer: d.manufacturer,
          model: d.model,
          ip: d.ip,
          port: d.port,
          location: '',
          notes: '',
          // Omitted entirely — the server fills in the default password for
          // devices that need one.
          deviceType: 'input',
        });
      }
      onClose();
    } finally {
      setAddingAll(false);
    }
  };

  const handleClose = () => {
    setForm({
      name: '', manufacturer: 'Sennheiser', model: '', ip: '',
      port: '443', location: 'Stage Left', notes: '', password: '', deviceType: 'input',
    });
    setError('');
    setExpandedKey(null);
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
                  {scanning ? (
                    <>
                      <Loader size={32} className="discover-spinner" />
                      <p className="discover-empty-title">Scanning network for devices…</p>
                      <p className="discover-empty-desc">
                        Checking for devices via mDNS, UDP broadcast, and HTTPS probe.
                        Make sure your hardware is powered on and on the same network segment.
                      </p>
                    </>
                  ) : (
                    <>
                      <Search size={32} className="discover-empty-icon" />
                      <p className="discover-empty-title">No devices found</p>
                      <p className="discover-empty-desc">
                        Nothing responded to the network scan. Make sure your hardware is powered on
                        and connected to the same network segment, then try scanning again.
                        You can also add a device manually by IP address.
                      </p>
                      <button className="btn-add-all" onClick={triggerScan}>
                        <RefreshCw size={13} /> Scan Again
                      </button>
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="discover-toolbar">
                    <span className="discover-count">
                      {scanning && <Loader size={11} className="btn-spinner" style={{ marginRight: 4 }} />}
                      {discovered.length} device{discovered.length !== 1 ? 's' : ''} found
                    </span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        className="btn-add-all"
                        onClick={triggerScan}
                        disabled={scanning}
                        title="Scan the network again"
                      >
                        <RefreshCw size={13} /> {scanning ? 'Scanning…' : 'Scan Again'}
                      </button>
                      <button
                        className="btn-add-all"
                        onClick={handleAddAll}
                        disabled={addingAll}
                        title={hasDefaultPassword ? `Using default password for authenticated devices` : `Add all with no password`}
                      >
                        {addingAll
                          ? <Loader size={13} className="btn-spinner" />
                          : <ListPlus size={13} />}
                        Add All ({discovered.length})
                      </button>
                    </div>
                  </div>

                  <div className="discovered-list">
                    {discovered.map((d) => (
                      <div key={d.key} className="discovered-item-wrapper">
                        <div className="discovered-item">
                          <div className="discovered-info">
                            <Wifi size={16} className="discovered-icon" />
                            <div>
                              <div className="discovered-name">{d.name}</div>
                              <div className="discovered-meta">{d.manufacturer} · {d.model} · {d.ip}:{d.port}</div>
                            </div>
                          </div>
                          <button
                            className={`btn-add-discovered ${expandedKey === d.key ? 'active' : ''}`}
                            onClick={() => handleDiscoveredClick(d)}
                          >
                            {expandedKey === d.key ? 'Cancel' : 'Add'}
                          </button>
                        </div>

                        {/* Inline form for SSC devices */}
                        {expandedKey === d.key && (
                          <div className="discovered-expand">
                            <div className="expand-row">
                              <label className="form-label">Device Type</label>
                              <div className="type-toggle">
                                <button
                                  className={`type-btn ${discoverForm.deviceType === 'input' ? 'active' : ''}`}
                                  onClick={() => setDiscoverForm(f => ({ ...f, deviceType: 'input' }))}
                                >
                                  <Mic size={13} /> Input
                                </button>
                                <button
                                  className={`type-btn ${discoverForm.deviceType === 'output' ? 'active' : ''}`}
                                  onClick={() => setDiscoverForm(f => ({ ...f, deviceType: 'output' }))}
                                >
                                  <Headphones size={13} /> Output (IEM)
                                </button>
                              </div>
                            </div>
                            <div className="expand-row">
                              <label className="form-label">Location</label>
                              <div className="select-wrap">
                                <select
                                  className="form-select"
                                  value={discoverForm.location}
                                  onChange={e => setDiscoverForm(f => ({ ...f, location: e.target.value }))}
                                >
                                  {LOCATIONS.map(l => <option key={l}>{l}</option>)}
                                </select>
                              </div>
                            </div>
                            <div className="expand-row">
                              <label className="form-label">
                                Password
                                {hasDefaultPassword && (
                                  <span className="label-optional"> (pre-filled from default)</span>
                                )}
                              </label>
                              <input
                                type="password"
                                className="form-input"
                                placeholder="EW-DX V4+ authentication password"
                                value={discoverForm.password}
                                onChange={e => setDiscoverForm(f => ({ ...f, password: e.target.value }))}
                                autoComplete="new-password"
                              />
                            </div>
                            <div className="expand-actions">
                              <button className="btn-primary-dialog" onClick={() => handleDiscoveredConfirm(d)}>
                                <PlusCircle size={14} /> Add to Inventory
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </>
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

                <div className="form-field form-field-full">
                  <label className="form-label">Device Type</label>
                  <div className="type-toggle">
                    <button
                      className={`type-btn ${form.deviceType === 'input' ? 'active' : ''}`}
                      onClick={() => setForm(f => ({ ...f, deviceType: 'input' }))}
                    >
                      <Mic size={13} /> Input (mic / instrument)
                    </button>
                    <button
                      className={`type-btn ${form.deviceType === 'output' ? 'active' : ''}`}
                      onClick={() => setForm(f => ({ ...f, deviceType: 'output' }))}
                    >
                      <Headphones size={13} /> Output (IEM)
                    </button>
                  </div>
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
                  <label className="form-label">
                    Model
                    {form.manufacturer === 'Shure' && <span className="label-required"> *</span>}
                  </label>
                  {/* For Shure the model is not decoration: it decides which
                      command vocabulary the receiver speaks (Axient and ULX-D
                      use different parameter names) and how many channels to
                      ask about. Getting it wrong looks like a dead device or a
                      half-missing one, so it is a list rather than free text. */}
                  {form.manufacturer === 'Shure' ? (
                    <>
                      <select
                        className="form-input"
                        value={form.model}
                        onChange={(e) => updateForm('model', e.target.value)}
                      >
                        <option value="">Select a model…</option>
                        {SHURE_MODELS.map(m => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                      <p className="form-hint">
                        Selects the command dialect and channel count. Axient and
                        SLX-D report their model when probed; ULX-D and QLX-D do not,
                        so pick theirs by hand.
                      </p>
                      {form.model.startsWith('SLXD') && (
                        <p className="form-hint form-hint-warn">
                          SLX-D blocks command strings by default. Enable network
                          control on the receiver first, or it will accept the
                          connection and answer nothing.
                        </p>
                      )}
                    </>
                  ) : (
                    <input
                      className="form-input"
                      placeholder="e.g. EW-DX EM 2"
                      value={form.model}
                      onChange={(e) => updateForm('model', e.target.value)}
                    />
                  )}
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
                  <span className="form-hint">
                    {MANUFACTURER_PORT_HINTS[form.manufacturer]?.hint}
                  </span>
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

                {form.manufacturer === 'Sennheiser' && (
                  <div className="form-field form-field-full">
                    <label className="form-label">
                      Password
                      {hasDefaultPassword && (
                        <span className="label-optional"> (pre-filled from default — EW-DX V4+)</span>
                      )}
                    </label>
                    <input
                      className="form-input"
                      type="password"
                      placeholder="Leave blank if no password is set"
                      value={form.password}
                      onChange={(e) => updateForm('password', e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                )}
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
