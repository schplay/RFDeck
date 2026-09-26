import React, { useEffect, useState } from 'react';
import { UploadCloud, DownloadCloud, HardDriveDownload, AlertTriangle, Check } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { useEntitled, FEATURES } from '../../hooks/useEntitled';
import './ConfigBackupCard.css';

/**
 * Settings → Cloud: back this whole install up, or rebuild it from the cloud.
 *
 * The counterpart to the show-file buttons, and deliberately a different thing.
 * A show file is portable — it carries a production to another venue and leaves
 * the local rig alone, because two venues have different hardware. This is the
 * opposite job: the box died, here is a new one, make it the old one.
 *
 * A restore rewrites the inventory, so it never happens on one click. The cloud's
 * snapshot is described first — how many devices, which passwords will need
 * re-entering — because "are you sure?" does not convey what is about to change.
 */

interface Preview {
  local: { devices: number; performers: number; audioPatch: number };
  cloud: {
    available: boolean;
    version: number | null;
    exportedAt: string | null;
    instance: { version: string | null; edition: string | null } | null;
    brings: string[];
    needsAttention: string[];
    reason: string | null;
  };
}

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString();
}

export function ConfigBackupCard() {
  const { allowed, reason } = useEntitled(FEATURES.backupConfig);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<'push' | 'restore' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setPreview(await apiFetch<Preview>('/cloud/config-backup/preview'));
    } catch (err) {
      // A 402 is the gate, which `useEntitled` already explains; anything else
      // is worth showing.
      if (!(err instanceof ApiError && err.status === 402)) setError((err as Error).message);
    }
  };

  useEffect(() => { if (allowed) void load(); }, [allowed]);

  const backUp = async () => {
    setNote(null); setError(null); setBusy('push');
    try {
      const result = await apiFetch<{ status: string; version: number }>(
        '/cloud/config-backup', { method: 'POST', body: JSON.stringify({}) },
      );
      setNote(result.status === 'already-current'
        ? `Already backed up — the cloud has this exact configuration (version ${result.version}).`
        : `Backed up as version ${result.version}.`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    const cloud = preview?.cloud;
    if (!cloud?.available) return;
    // The description the server built, in the confirmation itself. An operator
    // about to overwrite the wrong machine should be reading what changes, not a
    // generic warning.
    const confirmed = window.confirm(
      `Rebuild this install from the backup taken ${when(cloud.exportedAt)}?\n\n` +
      `This brings back:\n${cloud.brings.map(b => `  • ${b}`).join('\n')}\n\n` +
      (cloud.needsAttention.length
        ? `What it does not bring:\n${cloud.needsAttention.map(b => `  • ${b}`).join('\n')}\n\n`
        : '') +
      `Existing settings on this machine will be overwritten. Nothing is deleted — ` +
      `devices and performers added since the backup are left alone.`,
    );
    if (!confirmed) return;

    setNote(null); setError(null); setBusy('restore');
    try {
      const result = await apiFetch<{
        devices: number; performers: number; patches: number; webhooks: number;
      }>(
        '/cloud/config-backup/restore', { method: 'POST', body: JSON.stringify({ confirm: true }) },
      );
      setNote(
        `Restored ${result.devices} device${result.devices === 1 ? '' : 's'}, ` +
        `${result.performers} performer${result.performers === 1 ? '' : 's'}, ` +
        `${result.patches} audio assignment${result.patches === 1 ? '' : 's'} and ` +
        `${result.webhooks} webhook${result.webhooks === 1 ? '' : 's'}.`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-card mt-4">
      <h3><HardDriveDownload size={16} /> Configuration backup</h3>
      <p className="settings-desc">
        A snapshot of this whole install — the inventory, the roster, audio
        routing, webhooks, alert thresholds and network settings — so a replacement
        machine can be made into this one. Separate from show files, which travel
        between venues and deliberately leave the local rig alone.
      </p>
      <p className="settings-desc">
        <strong>It includes your device passwords and webhook secrets</strong>, so a
        restored rig connects and notifies without anything being re-entered. They
        are re-encrypted with the new machine's own key on the way in. Recordings,
        captured audio and performer photos are never included.
      </p>

      {!allowed ? (
        <p className="cloud-sub">{reason}</p>
      ) : (
        <>
          <div className="cloud-grid">
            <div className="cloud-row">
              <span className="cloud-label">On this machine</span>
              <span className="cloud-value">
                {preview
                  ? `${preview.local.devices} device${preview.local.devices === 1 ? '' : 's'}, ` +
                    `${preview.local.performers} performer${preview.local.performers === 1 ? '' : 's'}`
                  : '—'}
              </span>
            </div>
            <div className="cloud-row">
              <span className="cloud-label">In the cloud</span>
              <span className="cloud-value">
                {!preview ? '—' : preview.cloud.available
                  ? <>version {preview.cloud.version} · {when(preview.cloud.exportedAt)}</>
                  : <span className="cloud-sub">{preview.cloud.reason}</span>}
              </span>
            </div>
          </div>

          {/* What a restore would and would not bring, before anyone clicks it. */}
          {preview?.cloud.available && preview.cloud.needsAttention.length > 0 && (
            <div className="cloud-banner cloud-banner-warn" role="status">
              <AlertTriangle size={15} />
              <div>
                <strong>A restore would not bring back:</strong>
                {/* Short list by design — everything a rig needs to run does come
                    back, and these are the few things that are per-machine. */}
                <ul className="config-backup-caveats">
                  {preview.cloud.needsAttention.map(item => <li key={item}>{item}</li>)}
                </ul>
              </div>
            </div>
          )}

          {note && <p className="cloud-note"><Check size={14} /> {note}</p>}
          {error && <p className="cloud-error">{error}</p>}

          <div className="settings-form config-backup-actions">
            <button className="btn-primary" onClick={() => void backUp()} disabled={busy !== null}>
              <UploadCloud size={14} /> {busy === 'push' ? 'Backing up…' : 'Back up now'}
            </button>
            <button
              className="btn-ghost"
              onClick={() => void restore()}
              disabled={busy !== null || !preview?.cloud.available}
              title={preview?.cloud.available ? undefined : preview?.cloud.reason ?? undefined}
            >
              <DownloadCloud size={14} /> {busy === 'restore' ? 'Restoring…' : 'Restore this install'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
