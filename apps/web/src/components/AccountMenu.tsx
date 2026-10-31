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
 * Hidden entirely when the server can't sign people in, rather than shown
 * disabled: an offer that cannot be taken up is just clutter in a header
 * that is already busy.
 */

function initials(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.split('@')[0] || '';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function AccountMenu() {
  const canSignIn = useCloudStore(s => s.status.peopleCanSignIn);
  const { session, waiting, waitingPage, error, syncing, lastSync, remember,
          setRemember, signIn, cancel, signOut, sync } = usePersonStore();
  const person = session?.person ?? null;
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

  if (!canSignIn && !person) return null;

  const synced = lastSync
    ? lastSync.pulled.length + lastSync.pushed.length + lastSync.resolved.length
    : 0;

  return (
    <div className="am" ref={root}>
      <button
        className={`am-trigger ${person ? 'is-signed-in' : ''}`}
        onClick={() => setOpen(o => !o)}
        title={person ? `Signed in as ${person.name ?? person.email ?? person.sub}` : 'Sign in with Meros'}
        aria-expanded={open}
      >
        {person
          ? <span className="am-initials">{initials(person.name, person.email)}</span>
          : <UserCircle2 size={18} />}
      </button>

      {open && (
        <div className="am-panel" role="dialog" aria-label="Account">
          {person ? (
            <>
              <div className="am-who">
                <div className="am-name">{person.name ?? person.email ?? 'Signed in'}</div>
                {person.email && person.name && <div className="am-email">{person.email}</div>}
              </div>
              <p className="am-note">
                Your layout, meter settings and solo groups follow you to any RFDeck
                you sign in to.
              </p>
              <p className="am-note am-quiet">
                {person.persistent
                  ? 'Staying signed in on this machine.'
                  : 'Signed in until this tab closes.'}
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
          ) : waiting ? (
            <>
              <p className="am-note">
                Finish signing in on meros.co in your browser.
              </p>
              {waitingPage && (
                <a className="am-verify" href={waitingPage} target="_blank" rel="noreferrer">
                  Browser didn’t open? Open the sign-in page <ExternalLink size={12} />
                </a>
              )}
              <button className="am-action" onClick={() => void cancel()}>Cancel</button>
            </>
          ) : (
            <>
              <p className="am-note">
                Sign in with Meros and your preferences — layout, meters, solo groups
                — follow you between machines and venues. It changes nothing about
                the rig.
              </p>
              {/* Their call, because they know whether this is their laptop or the
                  venue's shared PC and RFDeck does not. Either way the session
                  renews itself — signing in is not an hourly chore. */}
              <label className="am-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={e => setRemember(e.target.checked)}
                />
                <span>
                  Keep me signed in on this machine
                  <em>Leave unticked on a shared venue computer.</em>
                </span>
              </label>
              {error && <p className="am-error">{error}</p>}
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
