import React, { useState, useEffect } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { Settings as SettingsIcon, Volume2, BellRing, Network } from 'lucide-react';
import './Settings.css';

interface AppSettings {
  aes67MulticastIp: string;
  aes67Port: number;
  batteryWarningPct: number;
  batteryCriticalPct: number;
  dropoutSensitivity: number;
  bindInterface: string;
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
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('http://localhost:3000/api/settings')
      .then(res => res.json())
      .then(data => {
        setSettings(data);
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
          <div className="settings-card">
            <h3>Audio Gateway Settings</h3>
            <p className="settings-desc">Configure the GStreamer AES-67 to WebRTC bridge.</p>
            
            <div className="settings-form">
              <div className="form-group">
                <label>AES-67 Multicast IP</label>
                <input 
                  type="text" 
                  value={settings.aes67MulticastIp}
                  onChange={e => setSettings({ ...settings, aes67MulticastIp: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>AES-67 Port</label>
                <input 
                  type="number" 
                  value={settings.aes67Port}
                  onChange={e => setSettings({ ...settings, aes67Port: parseInt(e.target.value) })}
                />
              </div>
              <button className="btn-primary" onClick={handleSave}>Save & Restart Gateway</button>
            </div>
          </div>
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
                  <option value="0.0.0.0">0.0.0.0 (All Interfaces)</option>
                  <option value="192.168.1.0">192.168.1.0 (Ethernet)</option>
                </select>
              </div>
              <button className="btn-primary" onClick={handleSave}>Save Settings</button>
            </div>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
