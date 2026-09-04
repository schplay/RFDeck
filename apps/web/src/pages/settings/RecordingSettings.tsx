import React, { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useDetectionStore } from '../../stores/detectionStore';

// Rolling capture: always on for every patched channel, bounded by a budget
// the operator sets against the disk they actually have.

export function RecordingSettings() {
  const { status, fetchStatus } = useDetectionStore();
  const [maxMb, setMaxMb] = useState<string>('');
  const [preSec, setPreSec] = useState<string>('');
  const [postSec, setPostSec] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (!status) return;
    setMaxMb(String(status.maxMb));
    setPreSec(String(status.preSec));
    setPostSec(String(status.postSec));
  }, [status?.maxMb, status?.preSec, status?.postSec]);

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/settings', { method: 'PUT', body: JSON.stringify(patch) });
      await fetchStatus();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      setError(err?.message ?? 'Could not save that setting.');
    } finally {
      setSaving(false);
    }
  };

  // Roughly what the budget buys: 48 kHz mono 16-bit is ~5.6 MB per minute,
  // and a clip is pre + post seconds long.
  const clipSeconds = (Number(preSec) || 0) + (Number(postSec) || 0);
  const clipMb = (clipSeconds * 48_000 * 2) / (1024 * 1024);
  const approxClips = clipMb > 0 ? Math.floor((Number(maxMb) || 0) / clipMb) : 0;

  const overFree = status?.freeMb != null && Number(maxMb) > status.freeMb;

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3>Rolling Capture</h3>
      </div>
      <p className="settings-desc">
        Every channel with an audio patch is recorded continuously. When RFDeck
        detects a problem it keeps the audio from around it, so you can hear what
        happened after the fact. Clips fill the budget below oldest-first; flagged
        clips are never removed automatically.
      </p>

      {error && <p className="settings-desc settings-warn">{error}</p>}

      {status && (
        <div className="settings-notice">
          <p className="settings-desc" style={{ margin: 0 }}>
            <HardDrive size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Recording <strong>{status.channels.length}</strong> patched channel
            {status.channels.length === 1 ? '' : 's'} ·
            using <strong>{status.usedMb} MB</strong> across {status.clipCount} clip
            {status.clipCount === 1 ? '' : 's'}
            {status.freeMb !== null && status.totalMb !== null && (
              <> · <strong>{(status.freeMb / 1024).toFixed(1)} GB</strong> free
                of {(status.totalMb / 1024).toFixed(1)} GB on this disk</>
            )}
          </p>
        </div>
      )}

      <div className="settings-form">
        <div className="form-group">
          <label>
            <input
              type="checkbox"
              checked={status?.enabled ?? true}
              disabled={saving}
              onChange={e => save({ recordingEnabled: e.target.checked })}
            />
            {' '}Record patched channels continuously
          </label>
          <p className="settings-desc-tight">
            Off means detections are still logged, but without audio to review.
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="rec-max">Maximum disk usage (MB)</label>
          <input
            id="rec-max"
            type="number"
            min={64}
            step={64}
            value={maxMb}
            disabled={saving}
            onChange={e => setMaxMb(e.target.value)}
            onBlur={() => { if (maxMb) save({ recordingMaxMb: Number(maxMb) }); }}
          />
          <p className="settings-desc-tight">
            {approxClips > 0 && <>About {approxClips} clips at {clipSeconds}s each. </>}
            {overFree
              ? 'This is more than the free space on the disk — clips will stop being written before the budget is reached.'
              : 'Oldest clips are discarded first once this is reached.'}
          </p>
        </div>

        <div className="form-group-row">
          <div className="form-group">
            <label htmlFor="rec-pre">Seconds before</label>
            <input
              id="rec-pre" type="number" min={1} max={120}
              value={preSec} disabled={saving}
              onChange={e => setPreSec(e.target.value)}
              onBlur={() => { if (preSec) save({ recordingPreSec: Number(preSec) }); }}
            />
          </div>
          <div className="form-group">
            <label htmlFor="rec-post">Seconds after</label>
            <input
              id="rec-post" type="number" min={0} max={120}
              value={postSec} disabled={saving}
              onChange={e => setPostSec(e.target.value)}
              onBlur={() => { if (postSec) save({ recordingPostSec: Number(postSec) }); }}
            />
          </div>
        </div>
        <p className="settings-desc-tight">
          The pre-roll is held in memory for every patched channel — roughly
          {' '}{((Number(preSec) || 0) * 48_000 * 2 / (1024 * 1024)).toFixed(1)} MB each,
          so a long pre-roll across many channels costs RAM rather than disk.
        </p>

        {saved && <p className="settings-desc">Saved.</p>}
      </div>
    </div>
  );
}
