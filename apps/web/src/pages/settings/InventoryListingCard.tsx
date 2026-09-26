import React, { useEffect, useState } from 'react';
import { UploadCloud, Boxes, Trash2, Check } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { useEntitled, FEATURES } from '../../hooks/useEntitled';
import './ConfigBackupCard.css';

/**
 * Settings → Cloud: publish this install's inventory to the operator's account.
 *
 * Not a backup and not a sync. It is a listing an operator reads from a phone when
 * somebody asks what hardware they own — so the rig is the source of truth and the
 * push goes one way. There is no pull, deliberately: a cloud listing that could
 * rewrite the local inventory would be a second, quieter path to the destruction the
 * configuration restore makes them confirm.
 */

interface State {
  local: { count: number };
  cloud: { available: boolean; reason: string | null; count: number; updatedAt: string | null };
}

function when(iso: string | null): string {
  if (!iso) return '—';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString();
}

export function InventoryListingCard() {
  const { allowed, reason } = useEntitled(FEATURES.inventory);
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState<'push' | 'clear' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setState(await apiFetch<State>('/cloud/inventory'));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 402)) setError((err as Error).message);
    }
  };

  useEffect(() => { if (allowed) void load(); }, [allowed]);

  const push = async () => {
    setNote(null); setError(null); setBusy('push');
    try {
      const result = await apiFetch<{ count: number }>(
        '/cloud/inventory', { method: 'POST', body: JSON.stringify({}) },
      );
      setNote(`Published ${result.count} device${result.count === 1 ? '' : 's'}.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    if (!window.confirm(
      'Remove this inventory listing from your Meros account?\n\n'
      + 'The devices on this machine are not touched — only the online copy is removed.',
    )) return;
    setNote(null); setError(null); setBusy('clear');
    try {
      await apiFetch('/cloud/inventory', { method: 'DELETE' });
      setNote('Removed the online listing.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // What the cloud holds versus what is here. Said plainly, because the push is a
  // reconcile: a second rig publishing to the same account replaces this listing
  // rather than adding to it, and the counts are how that becomes visible.
  const drifted = state?.cloud.available && state.cloud.count !== state.local.count;

  return (
    <div className="settings-card mt-4">
      <h3><Boxes size={16} /> Online inventory</h3>
      <p className="settings-desc">
        Publishes this install's device list to your Meros account, so you can look up
        what you own from anywhere without being at the rack. It is private to your
        account — there is no public or client-facing view — and it never includes
        device passwords.
      </p>
      <p className="settings-desc">
        Publishing <strong>replaces</strong> the listing rather than adding to it: this
        rig is the source of truth, so a device removed here disappears there. Nothing
        comes back the other way — use the configuration backup to restore hardware.
      </p>

      {!allowed ? (
        <p className="cloud-sub">{reason}</p>
      ) : (
        <>
          <div className="cloud-grid">
            <div className="cloud-row">
              <span className="cloud-label">On this machine</span>
              <span className="cloud-value">
                {state ? `${state.local.count} device${state.local.count === 1 ? '' : 's'}` : '—'}
              </span>
            </div>
            <div className="cloud-row">
              <span className="cloud-label">Published</span>
              <span className="cloud-value">
                {!state ? '—' : state.cloud.available
                  ? <>
                      {state.cloud.count} device{state.cloud.count === 1 ? '' : 's'}
                      <span className="cloud-sub"> · {when(state.cloud.updatedAt)}</span>
                    </>
                  : <span className="cloud-sub">{state.cloud.reason}</span>}
              </span>
            </div>
          </div>

          {drifted && (
            <p className="cloud-sub">
              The published listing no longer matches this machine. Publishing again
              will bring it up to date.
            </p>
          )}

          {note && <p className="cloud-note"><Check size={14} /> {note}</p>}
          {error && <p className="cloud-error">{error}</p>}

          <div className="settings-form config-backup-actions">
            <button className="btn-primary" onClick={() => void push()} disabled={busy !== null}>
              <UploadCloud size={14} /> {busy === 'push' ? 'Publishing…' : 'Publish inventory'}
            </button>
            {state?.cloud.available && state.cloud.count > 0 && (
              <button className="btn-ghost" onClick={() => void clear()} disabled={busy !== null}>
                <Trash2 size={14} /> {busy === 'clear' ? 'Removing…' : 'Remove listing'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
