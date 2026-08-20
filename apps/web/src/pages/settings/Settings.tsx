import React, { useState, useEffect } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { Volume2, BellRing, Network, RefreshCw } from 'lucide-react';
import { useAudioStore } from '../../stores/audioStore';
import { useAudioDevice } from '../../hooks/useAudioDevice';
import './Settings.css';

interface AppSettings {
  aes67MulticastIp: string;
  aes67Port: number;
  batteryWarningPct: number;
  batteryCriticalPct: number;
  dropoutSensitivity: number;
  bindInterface: string;
  defaultPassword: string;
}

interface NetworkInterface {
  name: string;
  address: string;
  label: string;
}

function AudioDeviceSettings() {
  const { selectedDeviceId, setSelectedDevice } = useAudioStore();
  const { availableDevices, refreshDevices } = useAudioDevice();

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3>Audio Interface</h3>
        <button className="btn-icon" onClick={refreshDevices} title="Refresh device list">
          <RefreshCw size={14} />
        </button>
      </div>
      <p className="settings-desc">
        Select the audio interface whose inputs are connected to your wireless receivers.
        After selecting an interface, open each device in the Inventory to assign its channels to specific inputs.
      </p>

      {availableDevices.length === 0 ? (
        <p className="settings-desc settings-warn">
          No audio input devices found. Make sure your interface is connected and the browser has microphone permission.
        </p>
      ) : (
        <div className="settings-form">
          <div className="form-group">
            <label>Audio Input Device</label>
            <select
              value={selectedDeviceId ?? ''}
              onChange={e => setSelectedDevice(e.target.value || null)}
            >
              <option value="">— Select an interface —</option>
              {availableDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Audio Input ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
          {selectedDeviceId && (
            <p className="settings-desc settings-ok">
              Interface selected. Open a device in Inventory to map its channels to audio inputs.
            </p>
          )}
        </div>
      )}
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
      fetch('http://localhost:3000/api/settings').then(res => res.json()),
      fetch('http://localhost:3000/api/system/network-interfaces').then(res => res.json()),
    ])
      .then(([settingsData, interfacesData]) => {
        setSettings({ ...settingsData, defaultPassword: settingsData.defaultPassword ?? '' });
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
      await fetch('http://localhost:3000/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      // Could show a success toast here
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
            <Volume2 size={16} /> Audio Device
          </Tabs.Trigger>
          <Tabs.Trigger value="alerts" className="tabs-trigger">
            <BellRing size={16} /> Alert Thresholds
          </Tabs.Trigger>
          <Tabs.Trigger value="network" className="tabs-trigger">
            <Network size={16} /> Network Config
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="audio" className="tabs-content">
          <AudioDeviceSettings />
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
              Pre-filled when adding devices — override per device in the Add Device dialog or device settings.
            </p>
            <div className="settings-form">
              <div className="form-group">
                <label>Default Password</label>
                <input
                  type="password"
                  value={settings.defaultPassword}
                  onChange={e => setSettings({ ...settings, defaultPassword: e.target.value })}
                  placeholder="Leave blank if not required"
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
