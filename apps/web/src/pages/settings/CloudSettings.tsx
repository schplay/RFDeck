import React, { useEffect, useState } from 'react';
import { Cloud, CloudOff, Link2, Unlink, AlertTriangle, Check, ExternalLink, RotateCcw } from 'lucide-react';
import { useCloudStore } from '../../stores/cloudStore';
import { API_BASE, apiFetch } from '../../lib/api';
import './CloudSettings.css';

/**
 * Settings → Cloud: link this rig to a Meros account, and see what that gets it.
 *
 * The device flow, because a rig may have no browser of its own and may be
 * reached only over a show LAN. The operator opens the verification URL on
 * whatever device is to hand — a phone is fine — approves it there, and this page
 * watches the server's polling.
 */

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString();
}

export function CloudSettings() {
  const { status, loaded, pending, busy, error,
          fetchStatus, startLink, pollLink, cancelLink, unlink,
          setEventsToCloud } = useCloudStore();
  const [venueLocation, setVenueLocation] = useState('');
  const [venueSaved, setVenueSaved] = useState(false);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  // Poll while a link is in flight. The server is doing the real polling; this
  // is just the page keeping up with it.
  useEffect(() => {
    if (!pending?.pending) return;
    const timer = setInterval(() => void pollLink(), 2000);
    return () => clearInterval(timer);
  }, [pending?.pending, pollLink]);

  useEffect(() => {
    fetch(`${API_BASE}/settings`)
      .then(r => r.json())
      .then(s => setVenueLocation(s.venueLocation ?? ''))
      .catch(() => { /* the page still works without it */ });
  }, []);

  const saveVenue = async () => {
    setVenueSaved(false);
    try {
      await apiFetch('/cloud/venue-location', {
        method: 'PUT',
        body: JSON.stringify({ venueLocation }),
      });
      setVenueSaved(true);
    } catch { /* surfaced by the absence of the tick */ }
  };

  if (!loaded) {
    return <div className="settings-card"><h3>Meros Cloud</h3><p className="settings-desc">Checking…</p></div>;
  }

  // Not configured is not a fault. Say what it would take, and stop.
  if (!status.configured) {
    return (
      <div className="settings-card">
        <h3><CloudOff size={16} /> Meros Cloud</h3>
        <p className="settings-desc">
          Not configured on this server, so cloud features are off. Everything else
          works exactly as it does now — RFDeck has never needed the cloud.
        </p>
        <p className="settings-desc">
          To enable it, set <code>MEROS_BASE_URL</code> and <code>MEROS_CLIENT_ID</code>
          {' '}in the server's environment and restart.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="settings-card">
        <h3><Cloud size={16} /> Meros Cloud</h3>
        <p className="settings-desc">
          Linking this rig to a Meros account gets it show files, regional data and
          relayed notifications. Nothing here is needed for the rig to work.
        </p>

        {/* A dead link is the one state that needs acting on, so it goes first. */}
        {status.needsRelink && (
          <div className="cloud-banner cloud-banner-error" role="alert">
            <AlertTriangle size={15} />
            <span>{status.needsRelink}</span>
          </div>
        )}

        {status.linked && status.offline && !status.needsRelink && (
          <div className="cloud-banner cloud-banner-warn" role="status">
            <CloudOff size={15} />
            <span>
              Meros is unreachable, so this is the last answer received. Paid
              features carry on working from it.
            </span>
          </div>
        )}

        <div className="cloud-grid">
          <div className="cloud-row">
            <span className="cloud-label">Status</span>
            <span className={`cloud-value ${status.linked ? 'is-linked' : ''}`}>
              {status.linked ? <><Check size={14} /> Linked</> : 'Not linked'}
            </span>
          </div>
          <div className="cloud-row">
            <span className="cloud-label">Server</span>
            <span className="cloud-value cloud-mono">{status.baseUrl ?? '—'}</span>
          </div>
          {status.linked && (
            <>
              <div className="cloud-row">
                <span className="cloud-label">Account</span>
                <span className="cloud-value cloud-mono">{status.accountId ?? '—'}</span>
              </div>
              <div className="cloud-row">
                <span className="cloud-label">Linked</span>
                <span className="cloud-value">{when(status.linkedAt)}</span>
              </div>
              <div className="cloud-row">
                <span className="cloud-label">Last contact</span>
                <span className="cloud-value">{when(status.lastRefreshAt)}</span>
              </div>
              <div className="cloud-row">
                <span className="cloud-label">Subscription</span>
                <span className="cloud-value">
                  {status.features.length === 0
                    ? 'No paid features on this account'
                    : status.features.map(f => f.replace(/^rfdeck\./, '')).join(', ')}
                  {status.expiresAt && <span className="cloud-sub"> · renews {when(status.expiresAt)}</span>}
                </span>
              </div>
            </>
          )}
        </div>

        {error && <p className="cloud-error">{error}</p>}

        {/* ── The device flow ───────────────────────────────────────────────── */}
        {pending?.pending ? (
          <div className="cloud-pending">
            <p className="settings-desc">
              Open this on any device — a phone is fine — sign in, and approve this rig.
            </p>
            <a
              className="cloud-verify-link"
              href={pending.verificationUriComplete ?? pending.verificationUri}
              target="_blank"
              rel="noreferrer"
            >
              {pending.verificationUri} <ExternalLink size={13} />
            </a>
            <div className="cloud-code" aria-label="Your code">{pending.userCode}</div>
            <p className="cloud-sub">
              Waiting for approval… the code expires {when(pending.expiresAt)}.
            </p>
            <button className="btn-ghost" onClick={() => void cancelLink()}>Cancel</button>
          </div>
        ) : pending && pending.outcome !== 'linked' ? (
          <div className="cloud-pending">
            <p className="cloud-error">
              {pending.detail ?? 'Linking did not complete.'}
            </p>
            <button className="btn-primary" onClick={() => void startLink()} disabled={busy}>
              <RotateCcw size={14} /> Try again
            </button>
          </div>
        ) : status.linked ? (
          <div className="settings-form">
            <button className="btn-ghost" onClick={() => void unlink()} disabled={busy}>
              <Unlink size={14} /> {busy ? 'Unlinking…' : 'Unlink this rig'}
            </button>
          </div>
        ) : (
          <div className="settings-form">
            <button className="btn-primary" onClick={() => void startLink()} disabled={busy}>
              <Link2 size={14} /> {busy ? 'Starting…' : 'Link this rig'}
            </button>
          </div>
        )}
      </div>

      {/* ── Events ───────────────────────────────────────────────────────────
          Off by default, and the copy is explicit about what turning it on means.
          Nobody should discover after the fact that their rig started reporting. */}
      {status.linked && (
        <div className="settings-card mt-4">
          <h3>Send events to the cloud</h3>
          <p className="settings-desc">
            RFDeck's own record of what happened — dropouts, battery warnings,
            devices going offline. Sending it to your Meros account is what lets you
            configure alerts there: choose which events matter and get an email or a
            text when one arrives. Recording and monitoring work exactly the same
            either way; this only decides whether the record leaves the building.
            <strong> No audio ever does.</strong>
          </p>
          <div className="settings-form">
            <label className="cloud-switch">
              <input
                type="checkbox"
                checked={status.eventsToCloud}
                onChange={e => void setEventsToCloud(e.target.checked)}
              />
              <span>{status.eventsToCloud ? 'Sending events' : 'Not sending events'}</span>
            </label>
            {status.eventsToCloud && status.eventsQueued > 0 && (
              <p className="cloud-sub">
                {status.eventsQueued} event{status.eventsQueued === 1 ? '' : 's'} waiting
                to be sent — they will go when the connection is back.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Venue location ───────────────────────────────────────────────────
          Only meaningful with regional data, but harmless to set beforehand. */}
      <div className="settings-card mt-4">
        <h3>Venue location</h3>
        <p className="settings-desc">
          Used to work out which TV channels are licensed here, so frequency
          coordination can keep out of them. <strong>It is never sent anywhere</strong> —
          the check runs on this machine against cached data, so the venue's
          position stays in the venue.
        </p>
        <div className="settings-form">
          <div className="form-group">
            <label>Postcode or coordinates</label>
            <input
              value={venueLocation}
              placeholder="e.g. 40.7128, -74.0060"
              onChange={e => { setVenueLocation(e.target.value); setVenueSaved(false); }}
            />
          </div>
          <button className="btn-primary" onClick={() => void saveVenue()}>
            {venueSaved ? <><Check size={14} /> Saved</> : 'Save location'}
          </button>
        </div>
      </div>
    </>
  );
}
