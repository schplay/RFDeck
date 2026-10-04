import React, { useCallback, useEffect, useState } from 'react';
import { UserCheck, LogOut, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useSocket } from '../../hooks/useSocket';

/**
 * The cloud user signed in on this server from Manifold, with a way to sign out.
 *
 * Shown because a long-lived sign-in associates this install with a named person
 * for up to a year, and whoever walks up to the rig should be able to see who
 * that is and end it. Signing out on Manifold does not end it — only signing out
 * here, or Meros refusing the sign-in, does.
 */

interface CloudSession {
  configured: boolean;
  signedIn: boolean;
  user: { sub: string; name: string | null; email: string | null } | null;
  signedInVia: string | null;
  signedInAt: string | null;
  signedOutReason: string | null;
}

export function CloudUserCard() {
  const { socket } = useSocket();
  const [session, setSession] = useState<CloudSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSession(await apiFetch<CloudSession>('/auth/cloud-session'));
    } catch {
      setSession(null);           // not configured, or not reachable over HTTPS
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // A sign-in from Manifold arrives while this page may be open.
  useEffect(() => {
    if (!socket) return;
    const onUser = (next: Omit<CloudSession, 'configured'>) =>
      setSession(prev => (prev ? { ...prev, ...next } : prev));
    socket.on('cloud:user', onUser);
    return () => { socket.off('cloud:user', onUser); };
  }, [socket]);

  if (!session?.configured) return null;

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/auth/cloud-signout', { method: 'POST' });
      await load();
    } catch (err) {
      setError((err as Error)?.message ?? 'Could not sign out.');
    } finally {
      setBusy(false);
    }
  };

  const who = session.user?.name ?? session.user?.email ?? session.user?.sub;

  return (
    <div className="settings-card mt-4">
      <h3><UserCheck size={16} /> Cloud user on this server</h3>

      {session.signedIn ? (
        <>
          <p className="settings-desc">
            <strong>{who}</strong>
            {session.user?.email && session.user.email !== who && <> ({session.user.email})</>} is
            signed in to Meros Cloud on this server
            {session.signedInVia === 'manifold' ? ', from Manifold' : ''}
            {session.signedInAt && <>, since {new Date(session.signedInAt).toLocaleString()}</>}.
            Signing out on Manifold does not sign them out here.
          </p>
          {error && <p className="cloud-error">{error}</p>}
          <div className="settings-form">
            <button className="btn-ghost" onClick={() => void signOut()} disabled={busy}>
              <LogOut size={14} /> {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </>
      ) : (
        <>
          {session.signedOutReason && (
            <div className="cloud-banner cloud-banner-warn" role="status">
              <AlertTriangle size={15} />
              <span>{session.signedOutReason}</span>
            </div>
          )}
          <p className="settings-desc">
            Nobody is signed in. A cloud user is signed in here from Manifold, when the
            console is connected to this server.
          </p>
        </>
      )}
    </div>
  );
}
