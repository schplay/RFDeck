import React, { useState, useMemo, useEffect } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { Activity, LayoutDashboard, Radio, Settings, Battery, Monitor, ClipboardList, Users, AlertTriangle, LayoutGrid, Layout, Menu, X, Keyboard, Lock, Unlock, type LucideIcon } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';
import { AudioMonitor } from '../components/audio/AudioMonitor';
import { AlertFeed } from '../components/alerts/AlertFeed';
import { LiveIndicator } from '../components/live/LiveIndicator';
import { useShortcutRegistry, useShortcuts, plainKey } from '../lib/shortcuts';
import { useUiStore } from '../stores/uiStore';
import { useCloudStore } from '../stores/cloudStore';
import { watchProfileChanges, flushProfileChanges } from '../lib/profileWatcher';
import { StatusBar } from '../components/StatusBar';
import { AccountMenu } from '../components/AccountMenu';
import { usePersonStore } from '../stores/personStore';
import { takeSignInReturn } from '../lib/signIn';
// Bundled import so the path survives base './' and the Electron file:// build.
import logoMark from '../assets/logo-mark.svg';
import './RootLayout.css';

// Listed for every environment mode, Stage Plot included: hiding a nav item
// based on which show happens to be open would make it vanish with no
// explanation, and a seating plan is as useful for a panel as for a band.
const NAV: { title: string; items: { to: string; label: string; icon: LucideIcon }[] }[] = [
  { title: 'Live', items: [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/rf', label: 'RF', icon: Radio },
    { to: '/battery', label: 'Batteries', icon: Battery },
    { to: '/detections', label: 'Detections', icon: AlertTriangle },
  ] },
  { title: 'Show', items: [
    { to: '/shows', label: 'Shows & Mic Check', icon: ClipboardList },
    { to: '/performers', label: 'Performers', icon: Users },
    { to: '/stage-plot', label: 'Stage Plot', icon: Layout },
  ] },
  { title: 'Hardware', items: [
    { to: '/inventory', label: 'Inventory', icon: Activity },
  ] },
  { title: 'Displays', items: [
    { to: '/micboard', label: 'Micboard', icon: LayoutGrid },
    { to: '/backstage', label: 'Backstage', icon: Monitor },
  ] },
];

export default function RootLayout() {
  const { isConnected } = useSocket();
  // Mobile only: the sidebar becomes an off-canvas drawer behind a hamburger.
  // Desktop ignores this state entirely — the sidebar is always visible there.
  const [navOpen, setNavOpen] = useState(false);

  // The account menu needs to know whether people can sign in, which comes
  // with cloud status.
  const fetchCloudStatus = useCloudStore(s => s.fetchStatus);
  useEffect(() => { void fetchCloudStatus(); }, [fetchCloudStatus]);

  // Back from signing in on meros.co: finish what it came back with. Read once;
  // the address is cleaned so a reload doesn't replay it.
  useEffect(() => {
    const back = takeSignInReturn();
    if (!back) return;
    if (back.outcome === 'person' && back.claim) void usePersonStore.getState().claim(back.claim);
    else if (back.outcome === 'linked') void useCloudStore.getState().linkReturned(null);
    else if (back.errorFor === 'person') usePersonStore.getState().failed(back.error ?? 'sign_in_failed');
    else void useCloudStore.getState().linkReturned(back.error ?? 'sign_in_failed');
  }, []);

  // Stamp and push preference changes. Idempotent, and a no-op when nobody is
  // signed in beyond recording when each change happened.
  useEffect(() => {
    watchProfileChanges();
    const onLeave = () => flushProfileChanges();
    window.addEventListener('pagehide', onLeave);
    return () => window.removeEventListener('pagehide', onLeave);
  }, []);

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
        {/* Grouped by when you reach for them: during the show, preparing it,
            the hardware itself, and the screens you hand to someone else.
            Settings sits apart at the bottom — it is not a place you visit
            mid-show. Any link tap closes the drawer; harmless on desktop. */}
        <div className="nav-links" onClick={() => setNavOpen(false)}>
          {NAV.map(section => (
            <div className="nav-section" key={section.title}>
              <div className="nav-section-title">{section.title}</div>
              {section.items.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
                >
                  <item.icon size={18} />
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
        <div className="nav-footer" onClick={() => setNavOpen(false)}>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            <Settings size={18} />
            Settings
          </NavLink>
        </div>
      </nav>
      <main className="main-content">
        <header className="topbar-tools">
          {/* Live or not, and which show: the one piece of global state an
              operator must never have to hunt for. It used to sit in a small
              box in the sidebar, truncated to "No show · si…". */}
          <div className="topbar-live"><LiveIndicator /></div>
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
          {/* Preferences that follow a person, and nothing else. Hidden when the
              server has no browser client configured. */}
          <AccountMenu />
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
