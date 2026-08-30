import React, { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { Activity, LayoutDashboard, Radio, Settings, Battery, Monitor, ClipboardList, Users, Menu, X } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';
import { AudioMonitor } from '../components/audio/AudioMonitor';
import { AlertFeed } from '../components/alerts/AlertFeed';
import './RootLayout.css';

export default function RootLayout() {
  const { isConnected } = useSocket();
  // Mobile only: the sidebar becomes an off-canvas drawer behind a hamburger.
  // Desktop ignores this state entirely — the sidebar is always visible there.
  const [navOpen, setNavOpen] = useState(false);

  const statusDot = (
    <div
      style={{ marginLeft: '8px', width: '8px', height: '8px', borderRadius: '50%', backgroundColor: isConnected ? 'var(--color-success)' : 'var(--color-error)' }}
      title={isConnected ? 'Connected to Server' : 'Disconnected'}
    />
  );

  return (
    <div className="layout-container">
      {/* Mobile top bar — hidden on desktop via CSS */}
      <div className="mobile-topbar">
        <button
          className="mobile-nav-toggle"
          onClick={() => setNavOpen(o => !o)}
          aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={navOpen}
        >
          {navOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
        <div className="brand brand-mobile">
          RFDeck
          {statusDot}
        </div>
      </div>

      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

      <nav className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="brand">
          RFDeck
          {statusDot}
        </div>
        {/* Any link tap closes the drawer; harmless on desktop. */}
        <div className="nav-links" onClick={() => setNavOpen(false)}>
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
          <NavLink to="/performers" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            <Users size={20} />
            Performers
          </NavLink>

          <div className="nav-divider" />

          <NavLink to="/backstage" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            <Monitor size={20} />
            Backstage View
          </NavLink>
        </div>
      </nav>
      <main className="main-content">
        <header className="topbar-tools">
          <AudioMonitor />
          <div className="topbar-divider" />
          <AlertFeed />
        </header>
        <Outlet />
      </main>
    </div>
  );
}
