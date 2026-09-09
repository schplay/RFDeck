import React, { useState, useMemo } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { Activity, LayoutDashboard, Radio, Settings, Battery, Monitor, ClipboardList, Users, AlertTriangle, LayoutGrid, Menu, X, Keyboard, Lock, Unlock } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';
import { AudioMonitor } from '../components/audio/AudioMonitor';
import { AlertFeed } from '../components/alerts/AlertFeed';
import { LiveIndicator } from '../components/live/LiveIndicator';
import { useShortcutRegistry, useShortcuts, plainKey } from '../lib/shortcuts';
import { useUiStore } from '../stores/uiStore';
import { StatusBar } from '../components/StatusBar';
// Bundled import so the path survives base './' and the Electron file:// build.
import logoMark from '../assets/logo-mark.png';
import './RootLayout.css';

export default function RootLayout() {
  const { isConnected } = useSocket();
  // Mobile only: the sidebar becomes an off-canvas drawer behind a hamburger.
  // Desktop ignores this state entirely — the sidebar is always visible there.
  const [navOpen, setNavOpen] = useState(false);

  const surfaceLocked = useUiStore(s => s.surfaceLocked);
  const setSurfaceLocked = useUiStore(s => s.setSurfaceLocked);

  // L locks, and only locks.
  //
  // Locking wants to be fast — the house is opening, someone is already holding
  // something. Unlocking does not: it is the act that makes every dangerous
  // control live again, and a key that could do it by accident would defeat the
  // point of having a lock. The header button is the way back.
  // Scoped to the operator shell rather than announced as global, because that
  // is the truth: the full-screen views do not mount this layout, so L does
  // nothing there. They also have nothing dangerous to lock.
  useShortcuts('Operator view', useMemo(() => [{
    keys: 'L',
    label: 'Lock the surface (unlock from the header)',
    match: plainKey('l'),
    run: () => setSurfaceLocked(true),
  }], [setSurfaceLocked]));

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
          <img src={logoMark} alt="" className="brand-logo" />
          RFDeck
          {statusDot}
        </div>
      </div>

      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

      <nav className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="brand">
          <img src={logoMark} alt="" className="brand-logo" />
          RFDeck
          {statusDot}
        </div>
        {/* Any link tap closes the drawer; harmless on desktop. */}
        <LiveIndicator />
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
          <NavLink to="/detections" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            <AlertTriangle size={20} />
            Detections
          </NavLink>

          <div className="nav-divider" />

          <NavLink to="/micboard" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            <LayoutGrid size={20} />
            Micboard
          </NavLink>
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
          {/* Locked state belongs in the chrome, not on the page that happens
              to own the control: an operator needs to know why a button did
              nothing, wherever they were when they pressed it. */}
          <button
            className={`topbar-lock ${surfaceLocked ? 'is-locked' : ''}`}
            onClick={() => setSurfaceLocked(!surfaceLocked)}
            aria-pressed={surfaceLocked}
            title={surfaceLocked
              ? 'The surface is locked: nothing that changes the rig can be operated. Click to unlock.'
              : 'Lock the surface so nothing that changes the rig can be operated. Press L to lock.'}
          >
            {surfaceLocked ? <Lock size={15} /> : <Unlock size={15} />}
            <span className="topbar-lock-label">{surfaceLocked ? 'Locked' : 'Unlocked'}</span>
          </button>
          {/* An entry point, because "?" only helps somebody who already knows
              to press it — which was the whole problem with the shortcuts that
              existed before. */}
          <button
            className="topbar-keys"
            onClick={() => useShortcutRegistry.getState().setHelpOpen(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard size={16} />
          </button>
        </header>
        <div className="main-scroll">
          <Outlet />
        </div>
        <StatusBar />
      </main>
    </div>
  );
}
