import React, { useRef, useState } from 'react';
import { Upload, Download, Trash2 } from 'lucide-react';
import { useScanStore } from '../../../stores/scanStore';
import { API_BASE } from '../../../lib/api';
import { useSurfaceLocked, LOCKED_REASON } from '../../../stores/uiStore';

// Which scan is drawn under the frequency map, and the way in and out.
//
// In: a file from Wireless Workbench, WSM, an RF Explorer export — read in
// the browser and posted as text. Out: the pair form every one of those
// tools imports. The server never handles a path.

export function ScanControls() {
  const locked = useSurfaceLocked();
  const { scans, selectedId, select, importText, remove } = useScanStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const text = await file.text();
      await importText(file.name.replace(/\.[^.]+$/, ''), text);
    } catch (err: any) {
      setError(err?.message ?? 'Import failed');
    } finally { setBusy(false); }
  };

  const selected = scans.find(s => s.id === selectedId) ?? null;

  return (
    <div className="scan-controls" role="group" aria-label="Spectrum scan">
      <select
        className="co-select"
        aria-label="Scan to show"
        value={selectedId ?? ''}
        onChange={e => select(e.target.value || null)}
      >
        <option value="">No scan</option>
        {scans.map(s => (
          <option key={s.id} value={s.id}>
            {s.name} — {(s.startKHz / 1000).toFixed(1)}–{(s.endKHz / 1000).toFixed(1)} MHz
          </option>
        ))}
      </select>
      {selected && (
        <span className="co-muted">
          {selected.source} · {selected.stepKHz} kHz · {new Date(selected.takenAt).toLocaleString()}
        </span>
      )}
      <span className="scan-controls-spacer" />
      <input ref={fileRef} type="file" accept=".csv,.txt" hidden onChange={onFile} aria-label="Scan file" />
      <button
        className="btn-secondary-rf" onClick={() => fileRef.current?.click()}
        disabled={busy || locked} title={locked ? LOCKED_REASON : 'Import a WWB, WSM or RF Explorer scan file'}
      >
        <Upload size={13} /> {busy ? 'Importing…' : 'Import scan'}
      </button>
      {selected && (
        <>
          <a className="btn-secondary-rf" href={`${API_BASE}/scans/${selected.id}/export.csv`} download title="Export in the form WWB, WSM and IAS import">
            <Download size={13} /> Export
          </a>
          <button
            className="btn-secondary-rf" disabled={locked} title={locked ? LOCKED_REASON : 'Delete this scan'}
            onClick={() => window.confirm(`Delete scan “${selected.name}”?`) && remove(selected.id).catch(err => setError(err?.message ?? 'Delete failed'))}
            aria-label={`Delete scan ${selected.name}`}
          >
            <Trash2 size={13} />
          </button>
        </>
      )}
      {error && <span className="co-note co-note-err" role="alert">{error}</span>}
    </div>
  );
}
