import React, { useState, useEffect } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { Volume2, BellRing, Network, RefreshCw, ShieldCheck } from 'lucide-react';
import { apiFetch, fetchAuthStatus, AuthStatus, API_BASE } from '../../lib/api';
import { AudioPatchSettings } from './AudioPatch';
import { AES67RoutingSettings } from './AES67Routing';
import './Settings.css';

interface AppSettings {
  aes67MulticastIp: string;
  aes67Port: number;
  batteryWarningPct: number;
  batteryCriticalPct: number;
  dropoutSensitivity: number;
  bindInterface: string;
  /** Write-only. The server never returns the stored value; blank means "keep". */
  defaultPassword: string;
  hasDefaultPassword?: boolean;
}

interface NetworkInterface {
  name: string;
  address: string;
  label: string;
}

// ── Remote access ──
// RFDeck defaults to an open, trusted show network. An admin can require a PIN
// from remote clients and choose how often they must re-enter it. Configurable
// only from the host machine — with no user accounts there is no other way to
// tell an admin from any other client on the network.
function RemoteAccessSettings() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [pinIsSet, setPinIsSet] = useState(false);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [reauthHours, setReauthHours] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    fetchAuthStatus()
      .then(s => { setStatus(s); setReauthHours(s.reauthHours); })
      .catch(() => setMessage({ kind: 'err', text: 'Could not reach the server.' }));
  }, []);

  const save = async (next: { pinEnabled?: boolean; pin?: string; reauthHours?: number }) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await apiFetch<{ pinEnabled: boolean; reauthHours: number; pinIsSet: boolean }>(
        '/auth/config', { method: 'PUT', body: JSON.stringify(next) }
      );
      setStatus(s => (s ? { ...s, pinEnabled: result.pinEnabled, reauthHours: result.reauthHours } : s));
      setReauthHours(result.reauthHours);
      setPinIsSet(result.pinIsSet);
      setPin(''); setConfirmPin('');
      setMessage({ kind: 'ok', text: 'Access settings saved.' });
    } catch (err: any) {
      setMessage({ kind: 'err', text: err?.message ?? 'Could not save access settings.' });
    } finally {
      setBusy(false);
    }
  };

  const savePin = () => {
    if (pin.length < 4) {
      return setMessage({ kind: 'err', text: 'Use at least 4 digits.' });
    }
    if (pin !== confirmPin) {
      return setMessage({ kind: 'err', text: 'The two PINs do not match.' });
    }
    save({ pin, pinEnabled: true, reauthHours });
  };

  if (!status) {
    return <div className="settings-card"><p className="settings-desc">Loading access settings…</p></div>;
  }

  // A headless server has no browser on the host, so "configure it locally" is
  // not advice anyone can follow. Whoever knows the current PIN may change it;
  // shell access to the server is the recovery path when nobody does.
  if (!status.canConfigure) {
    return (
      <div className="settings-card">
        <div className="settings-card-header"><h3>Remote Access</h3></div>
        <p className="settings-desc settings-warn">
          <strong>Enter the current PIN to change these settings.</strong>
        </p>
        <p className="settings-desc">
          This device has not authenticated with the PIN, so it cannot change it.
          Reload and enter the PIN, then come back here.
        </p>
        <p className="settings-desc" style={{ marginTop: 8 }}>
          Forgotten it? Reset from a shell on the server:
        </p>
        <pre className="settings-code">sudo rfdeck set-pin 1234</pre>
      </div>
    );
  }

  return (
    <div className="settings-card">
      <div className="settings-card-header"><h3>Remote Access</h3></div>
      <p className="settings-desc">
        RFDeck trusts the local network by default, so any device that can reach this
        machine can connect. Require a PIN if the show network is shared with house or
        guest traffic. A browser on the machine running RFDeck is always exempt, and a
        shell there can always reset the PIN with `rfdeck set-pin`.
      </p>

      <div className="settings-form">
        <div className="form-group form-group-row">
          <div>
            <label>Require a PIN for remote devices</label>
            <p className="settings-desc settings-desc-tight">
              {status.pinEnabled
                ? 'Remote devices must enter the PIN before seeing any data.'
                : 'Any device on the network can connect freely.'}
            </p>
          </div>
          <button
            className={`active-switch ${status.pinEnabled ? 'on' : 'off'}`}
            role="switch"
            aria-checked={status.pinEnabled}
            disabled={busy || (!status.pinEnabled && !pinIsSet && pin.length < 4)}
            onClick={() => save({ pinEnabled: !status.pinEnabled })}
            title={!status.pinEnabled && !pinIsSet ? 'Set a PIN first' : undefined}
          >
            <span className="active-switch-knob" />
          </button>
        </div>

        <div className="form-group">
          <label>{pinIsSet ? 'Change PIN' : 'Set PIN'}</label>
          <input
            type="password" inputMode="numeric" autoComplete="new-password"
            value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder="At least 4 digits" maxLength={12}
          />
        </div>

        <div className="form-group">
          <label>Confirm PIN</label>
          <input
            type="password" inputMode="numeric" autoComplete="new-password"
            value={confirmPin} onChange={e => setConfirmPin(e.target.value.replace(/\D/g, ''))}
            placeholder="Re-enter the PIN" maxLength={12}
          />
        </div>

        <div className="form-group">
          <label>Ask again after</label>
          <select value={reauthHours} onChange={e => setReauthHours(Number(e.target.value))}>
            <option value={0}>Never — stay signed in</option>
            <option value={12}>12 hours</option>
            <option value={24}>1 day</option>
            <option value={72}>3 days</option>
            <option value={168}>1 week</option>
          </select>
          <p className="settings-desc settings-desc-tight">
            A resident booth display usually wants "never". Shorter intervals suit
            devices that leave the venue.
          </p>
        </div>

        {message && (
          <p className={`settings-desc ${message.kind === 'ok' ? 'settings-ok' : 'settings-warn'}`}>
            {message.text}
          </p>
        )}

        <div className="settings-actions-row">
          <button className="btn-primary" onClick={savePin} disabled={busy || !pin}>
            Save PIN
          </button>
          {status.pinEnabled && (
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm('Sign out every remote device? They will need the PIN again.')) return;
                setBusy(true);
                try {
                  await apiFetch('/auth/revoke-all', { method: 'POST' });
                  setMessage({ kind: 'ok', text: 'All remote devices signed out.' });
                } catch {
                  setMessage({ kind: 'err', text: 'Could not sign devices out.' });
                } finally { setBusy(false); }
              }}
            >
              Sign out all devices
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Settings() {
  const [activeTab, setActiveTab] = useState('audio');
  const [settings, setSettings] = useState<AppSettings>({
    aes67MulticastIp: '239.69.0.1',
    aes67Port: 5004,
    batteryWarningPct: 20,
    batteryCriticalPct: 5,
    dropoutSensitivity: 20,
    bindInterface: '0.0.0.0',
    defaultPassword: '',
  });
  const [loading, setLoading] = useState(true);
  const [networkInterfaces, setNetworkInterfaces] = useState<NetworkInterface[]>([]);

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/settings`).then(res => res.json()),
      fetch(`${API_BASE}/system/network-interfaces`).then(res => res.json()),
    ])
      .then(([settingsData, interfacesData]) => {
        // defaultPassword is always blank coming back — it is write-only.
        setSettings({ ...settingsData, defaultPassword: '' });
        setNetworkInterfaces(interfacesData);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to fetch settings', err);
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const saved = await res.json();
      // Clear the password field again — a blank field means "keep the stored
      // one", so leaving the typed value visible would be misleading.
      setSettings({ ...saved, defaultPassword: '' });
    } catch (err) {
      console.error('Failed to save settings', err);
    }
  };

  if (loading) return <div className="settings-page">Loading settings...</div>;

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1>Settings</h1>
      </div>

      <Tabs.Root className="settings-tabs" value={activeTab} onValueChange={setActiveTab}>
        <Tabs.List className="tabs-list">
          <Tabs.Trigger value="audio" className="tabs-trigger">
            <Volume2 size={16} /> Audio Patch
          </Tabs.Trigger>
          <Tabs.Trigger value="alerts" className="tabs-trigger">
            <BellRing size={16} /> Alert Thresholds
          </Tabs.Trigger>
          <Tabs.Trigger value="network" className="tabs-trigger">
            <Network size={16} /> Network Config
          </Tabs.Trigger>
          <Tabs.Trigger value="access" className="tabs-trigger">
            <ShieldCheck size={16} /> Remote Access
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="audio" className="tabs-content">
          {/* Routing first, then patching: a stream has to be arriving at the
              server before there is anything to patch a channel to. */}
          <AES67RoutingSettings />
          <AudioPatchSettings />
        </Tabs.Content>

        <Tabs.Content value="access" className="tabs-content">
          <RemoteAccessSettings />
        </Tabs.Content>

        <Tabs.Content value="alerts" className="tabs-content">
          <div className="settings-card">
            <h3>Battery Alerts</h3>
            <p className="settings-desc">Global thresholds for all battery powered devices.</p>
            
            <div className="settings-form">
              <div className="form-group">
                <label>Warning Threshold (%)</label>
                <input 
                  type="number" 
                  value={settings.batteryWarningPct}
                  onChange={e => setSettings({ ...settings, batteryWarningPct: parseInt(e.target.value) })}
                />
              </div>
              <div className="form-group">
                <label>Critical Threshold (%)</label>
                <input 
                  type="number" 
                  value={settings.batteryCriticalPct}
                  onChange={e => setSettings({ ...settings, batteryCriticalPct: parseInt(e.target.value) })}
                />
              </div>
            </div>
          </div>
          
          <div className="settings-card mt-4">
            <h3>RF Alerts</h3>
            <div className="settings-form">
              <div className="form-group">
                <label>Dropout Sensitivity (%)</label>
                <input 
                  type="number" 
                  value={settings.dropoutSensitivity}
                  onChange={e => setSettings({ ...settings, dropoutSensitivity: parseInt(e.target.value) })}
                />
              </div>
              <button className="btn-primary" onClick={handleSave}>Save Settings</button>
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="network" className="tabs-content">
          <div className="settings-card">
            <h3>Server Network Configuration</h3>
            <p className="settings-desc">Used for mDNS discovery and hardware communication.</p>

            <div className="settings-form">
              <div className="form-group">
                <label>Bind Interface</label>
                <select
                  value={settings.bindInterface}
                  onChange={e => setSettings({ ...settings, bindInterface: e.target.value })}
                >
                  {networkInterfaces.map(iface => (
                    <option key={iface.address} value={iface.address}>
                      {iface.label}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn-primary" onClick={handleSave}>Save Settings</button>
            </div>
          </div>

          <div className="settings-card mt-4">
            <h3>Device Authentication</h3>
            <p className="settings-desc">
              Default password for devices with authentication enabled (e.g. Sennheiser EW-DX V4+).
              Applied automatically when a device is added without its own password.
              It is encrypted at rest and never sent back to a browser, so the field
              below is always blank — leave it blank to keep the stored password.
            </p>
            <div className="settings-form">
              <div className="form-group">
                <label>
                  Default Password
                  {settings.hasDefaultPassword && (
                    <span className="settings-badge-set">Set</span>
                  )}
                </label>
                <input
                  type="password"
                  value={settings.defaultPassword}
                  onChange={e => setSettings({ ...settings, defaultPassword: e.target.value })}
                  placeholder={settings.hasDefaultPassword
                    ? '●●●● stored — type to replace'
                    : 'Leave blank if not required'}
                  autoComplete="new-password"
                />
              </div>
              <button className="btn-primary" onClick={handleSave}>Save Settings</button>
            </div>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
