import React, { useEffect, useRef, useState } from 'react';
import { UserCircle2, LogOut, RefreshCw, ExternalLink, Check } from 'lucide-react';
import { usePersonStore } from '../stores/personStore';
import { useCloudStore } from '../stores/cloudStore';
import './AccountMenu.css';

/**
 * Sign in with Meros, so your preferences follow you.
 *
 * Deliberately modest about what it is for. Signing in here does not affect the
 * rig, does not change what the server can do, and is not required for anything —
 * it carries a layout between venues. Overselling it would invite an operator to
 * think RFDeck needed it.
 *
 * Hidden entirely when the server has no browser client configured, rather than
 * shown disabled: an offer that cannot be taken up is just clutter in a header
 * that is already busy.
 */

function initials(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.split('@')[0] || '';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function AccountMenu() {
  const browserClientId = useCloudStore(s => s.status.browserClientId);
  const { session, pending, outcome, error, syncing, lastSync,
          signIn, cancel, signOut, sync } = usePersonStore();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  if (!browserClientId) return null;

  const synced = lastSync
    ? lastSync.pulled.length + lastSync.pushed.length + lastSync.resolved.length
    : 0;

  return (
    <div className="am" ref={root}>
      <button
        className={`am-trigger ${session ? 'is-signed-in' : ''}`}
        onClick={() => setOpen(o => !o)}
        title={session ? `Signed in as ${session.name ?? session.email ?? session.sub}` : 'Sign in with Meros'}
        aria-expanded={open}
      >
        {session
          ? <span className="am-initials">{initials(session.name, session.email)}</span>
          : <UserCircle2 size={18} />}
      </button>

      {open && (
        <div className="am-panel" role="dialog" aria-label="Account">
          {session ? (
            <>
              <div className="am-who">
                <div className="am-name">{session.name ?? session.email ?? 'Signed in'}</div>
                {session.email && session.name && <div className="am-email">{session.email}</div>}
              </div>
              <p className="am-note">
                Your layout, meter settings and solo groups follow you to any RFDeck
                you sign in to.
              </p>
              {lastSync && (
                <p className="am-synced">
                  <Check size={12} />
                  {synced === 0 ? 'Preferences already in step' : `${synced} preference${synced === 1 ? '' : 's'} synced`}
                </p>
              )}
              {error && <p className="am-error">{error}</p>}
              <div className="am-actions">
                <button className="am-action" onClick={() => void sync()} disabled={syncing}>
                  <RefreshCw size={13} className={syncing ? 'am-spin' : undefined} />
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
                <button className="am-action" onClick={() => void signOut()}>
                  <LogOut size={13} /> Sign out
                </button>
              </div>
            </>
          ) : pending ? (
            <>
              <p className="am-note">
                Open this on your phone, sign in, and approve.
              </p>
              <a className="am-verify" href={pending.verificationUriComplete ?? pending.verificationUri}
                 target="_blank" rel="noreferrer">
                {pending.verificationUri} <ExternalLink size={12} />
              </a>
              <div className="am-code">{pending.userCode}</div>
              <button className="am-action" onClick={cancel}>Cancel</button>
            </>
          ) : (
            <>
              <p className="am-note">
                Sign in with Meros and your preferences — layout, meters, solo groups
                — follow you between machines and venues. It changes nothing about
                the rig.
              </p>
              {outcome === 'denied' && <p className="am-error">That request was declined.</p>}
              {outcome === 'expired' && <p className="am-error">The code expired. Try again.</p>}
              {outcome === 'error' && error && <p className="am-error">{error}</p>}
              <button className="am-action am-primary" onClick={() => void signIn()}>
                <UserCircle2 size={13} /> Sign in with Meros
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
