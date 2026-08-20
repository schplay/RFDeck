import React from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { Activity, LayoutDashboard, Radio, Settings, Battery, Monitor, ClipboardList } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';
import { AudioMonitor } from '../components/audio/AudioMonitor';
import { AlertFeed } from '../components/alerts/AlertFeed';
import './RootLayout.css';

export default function RootLayout() {
  const { isConnected } = useSocket();

  return (
    <div className="layout-container">
      <nav className="sidebar">
        <div className="brand">
          RFDeck
          <div style={{ marginLeft: '8px', width: '8px', height: '8px', borderRadius: '50%', backgroundColor: isConnected ? 'var(--color-success)' : 'var(--color-error)' }} title={isConnected ? "Connected to Server" : "Disconnected"} />
        </div>
        <div className="nav-links">
          <NavLink to="/" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            <LayoutDashboard size={20} />
            Dashboard
          </NavLink>
          <NavLink to="/inventory" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            <Activity size={20} />
            Inventory
          </NavLink>
          <NavLink to="/rf" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            <Radio size={20} />
            RF Environment
          </NavLink>
          <NavLink to="/battery" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            <Battery size={20} />
            Battery Management
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            <Settings size={20} />
            Settings
          </NavLink>
          <NavLink to="/shows" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            <ClipboardList size={20} />
            Show & Mic Check
          </NavLink>

          <div className="nav-divider" />

          <NavLink to="/backstage" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            <Monitor size={20} />
            Backstage View
          </NavLink>
        </div>
      </nav>
      <main className="main-content">
        <header style={{ padding: '16px 24px', display: 'flex', justifyContent: 'flex-end', gap: '16px', alignItems: 'center', borderBottom: '1px solid var(--color-surface-container-high)' }}>
          <AudioMonitor />
          <div style={{ width: '1px', height: '24px', backgroundColor: 'var(--color-surface-container-highest)' }} />
          <AlertFeed />
        </header>
        <Outlet />
      </main>
    </div>
  );
}
