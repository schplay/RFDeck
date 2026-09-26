import React, { useState } from 'react';
import { UploadCloud, DownloadCloud, Check, AlertTriangle } from 'lucide-react';
import { API_BASE, apiFetch } from '../../lib/api';
import { useCloudStore } from '../../stores/cloudStore';
import { useShowStore } from '../../stores/showStore';
import './CloudShowActions.css';

/**
 * Save this show to the cloud, or take the cloud's copy.
 *
 * Both are explicit: an operator moving between venues wants "get my show from
 * last week", not a background sync on a live rig. Nothing here appears unless
 * the instance is actually linked — an unlinked rig should not be shown buttons
 * that cannot work.
 */

interface Conflict {
  message: string;
  headVersion: number;
  headUpdatedAt: string | null;
}

export function CloudShowActions({ showId, showName }: { showId: string; showName: string }) {
  const linked = useCloudStore(s => s.status.linked);
  const fetchShows = useShowStore(s => s.fetchShows);
  const [busy, setBusy] = useState<'push' | 'pull' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  // An unlinked or unconfigured rig gets nothing rather than a disabled button:
  // this is a cloud nicety, not a feature of the show page.
  if (!linked) return null;

  const clear = () => { setNote(null); setError(null); setConflict(null); };

  const push = async () => {
    clear();
    setBusy('push');
    try {
      const res = await fetch(`${API_BASE}/cloud/showfiles/${encodeURIComponent(showId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await res.json();
      if (res.status === 409) {
        setConflict({
          message: body?.message ?? 'The cloud copy has changed.',
          headVersion: body?.head?.version ?? 0,
          headUpdatedAt: body?.head?.updatedAt ?? null,
        });
      } else if (!res.ok) {
        setError(body?.message ?? `Could not save to the cloud (HTTP ${res.status}).`);
      } else if (body.status === 'already-current') {
        // Not a failure and not a conflict: the cloud already has this exact
        // show. Say so plainly instead of asking a question with no answer.
        setNote(`Already saved — the cloud has this version (${body.version}).`);
      } else {
        setNote(`Saved as version ${body.version}.`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pull = async (confirmFirst: boolean) => {
    if (confirmFirst && !window.confirm(
      `Replace the local copy of "${showName}" with the cloud's?\n\n` +
      `The cast, channel assignments, quick changes and mic-check ticks on this ` +
      `machine will be overwritten. This cannot be undone.`,
    )) return;

    clear();
    setBusy('pull');
    try {
      const result = await apiFetch(`/cloud/showfiles/${encodeURIComponent(showId)}/pull`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await fetchShows();
      setNote(`Opened the cloud copy (version ${(result as any)?.version ?? '?'}).`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button
        className="btn-ghost"
        onClick={() => void push()}
        disabled={busy !== null}
        title="Save this show to the cloud, so it can be opened at another venue"
      >
        <UploadCloud size={14} /> {busy === 'push' ? 'Saving…' : 'Save to cloud'}
      </button>
      <button
        className="btn-ghost"
        onClick={() => void pull(true)}
        disabled={busy !== null}
        title="Replace this show with the copy in the cloud"
      >
        <DownloadCloud size={14} /> {busy === 'pull' ? 'Opening…' : 'Open from cloud'}
      </button>

      {/* The conflict. Both options are named, and neither is the default —
          RFDeck does not know which copy is the one the operator wants. */}
      {conflict && (
        <div className="csa-conflict" role="alert">
          <div className="csa-conflict-head">
            <AlertTriangle size={15} />
            <strong>The cloud copy changed since you last synced.</strong>
          </div>
          <p className="csa-conflict-body">
            It is now version {conflict.headVersion}
            {conflict.headUpdatedAt && `, saved ${new Date(conflict.headUpdatedAt).toLocaleString()}`}.
            Someone else pushed this show, or you pushed it from another machine.
          </p>
          <div className="csa-conflict-actions">
            <button
              className="btn-ghost"
              onClick={() => { setConflict(null); void pull(true); }}
            >
              <DownloadCloud size={14} /> Take the cloud's copy
            </button>
            <button className="btn-ghost" onClick={() => setConflict(null)}>
              Keep mine for now
            </button>
          </div>
          <p className="csa-conflict-foot">
            Keeping yours changes nothing yet. To overwrite the cloud, open its
            copy first and re-apply your changes — there is no merge, because
            merging two casts produces a list nobody wrote.
          </p>
        </div>
      )}

      {note && <span className="csa-note"><Check size={13} /> {note}</span>}
      {error && <span className="csa-error">{error}</span>}
    </>
  );
}
