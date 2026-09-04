import React, { useEffect, useState } from 'react';
import { AlertTriangle, Flag, Trash2, X, RefreshCw, HardDrive } from 'lucide-react';
import { useDetectionStore, Detection } from '../../stores/detectionStore';
import { API_BASE, getToken } from '../../lib/api';
import './DetectionsPage.css';

// Problems RFDeck noticed on its own, each with the audio that proves it.
//
// The point is the operator did not hear it at the time: a dropout during a
// number nobody was watching. Flagging keeps a clip permanently; dismissing
// clears it from the working list without losing the record.

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// A navigation cannot carry the auth header, so the token rides along for
// media the browser fetches itself — same rule as the printable show report.
function clipUrl(id: string): string {
  const token = getToken();
  return `${API_BASE}/detections/${id}/clip${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

export default function DetectionsPage() {
  const {
    detections, status, loading, error,
    fetchDetections, fetchStatus, setFlagged, setNote, dismiss, remove,
  } = useDetectionStore();
  const [showDismissed, setShowDismissed] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  useEffect(() => {
    void fetchDetections({ includeDismissed: showDismissed });
    void fetchStatus();
  }, [fetchDetections, fetchStatus, showDismissed]);

  const visible = flaggedOnly ? detections.filter(d => d.flagged) : detections;

  const openNote = (d: Detection) => {
    setNoteFor(d.id);
    setNoteDraft(d.note ?? '');
  };
  const saveNote = () => {
    if (noteFor) void setNote(noteFor, noteDraft.trim());
    setNoteFor(null);
  };

  return (
    <div className="det-page">
      <header className="det-header">
        <div>
          <h1 className="page-title">Detections</h1>
          <p className="det-subtitle">
            Problems RFDeck noticed on its own, with the audio from around each one.
            Flag the ones worth keeping — flagged clips are never pruned.
          </p>
        </div>
        <button
          className="btn-icon"
          onClick={() => { void fetchDetections({ includeDismissed: showDismissed }); void fetchStatus(); }}
          title="Refresh"
          disabled={loading}
        >
          <RefreshCw size={14} />
        </button>
      </header>

      {status && (
        <div className="det-status">
          <HardDrive size={14} />
          {status.enabled ? (
            <span>
              Recording <strong>{status.channels.length}</strong> patched channel
              {status.channels.length === 1 ? '' : 's'} · {status.preSec}s before / {status.postSec}s after
              · <strong>{status.usedMb} MB</strong> of {status.maxMb} MB used by {status.clipCount} clip
              {status.clipCount === 1 ? '' : 's'}
              {status.freeMb !== null && <> · {(status.freeMb / 1024).toFixed(1)} GB free on disk</>}
            </span>
          ) : (
            <span className="det-status-off">
              Rolling capture is switched off — detections will be recorded without audio.
              Turn it on in Settings → Audio.
            </span>
          )}
        </div>
      )}

      {status?.enabled && status.channels.length === 0 && (
        <div className="det-notice">
          No channel has an audio patch yet, so there is nothing to record. Assign
          inputs in Settings → Audio and recording starts immediately.
        </div>
      )}

      {error && <p className="det-error">{error}</p>}

      <div className="det-filters">
        <label className="det-check">
          <input type="checkbox" checked={flaggedOnly} onChange={e => setFlaggedOnly(e.target.checked)} />
          Flagged only
        </label>
        <label className="det-check">
          <input type="checkbox" checked={showDismissed} onChange={e => setShowDismissed(e.target.checked)} />
          Include dismissed
        </label>
        <span className="det-count">{visible.length} shown</span>
      </div>

      {loading && detections.length === 0 ? (
        <p className="det-empty">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="det-empty">
          <AlertTriangle size={32} />
          <p>
            Nothing detected. Dropouts and other wireless problems appear here
            automatically, with a clip you can listen to.
          </p>
        </div>
      ) : (
        <div className="det-list">
          {visible.map(d => (
            <div key={d.id} className={`det-row ${d.flagged ? 'flagged' : ''} ${d.dismissed ? 'dismissed' : ''}`}>
              <div className="det-when">
                <span className="det-time">{formatTime(d.timestamp)}</span>
                <span className="det-date">{formatDate(d.timestamp)}</span>
              </div>

              <div className="det-what">
                <div className="det-title-row">
                  <span className={`det-sev det-sev-${d.severity.toLowerCase()}`}>{d.trigger.replace(/_/g, ' ')}</span>
                  <span className="det-channel">{d.channelName ?? d.channelKey}</span>
                  {d.act != null && <span className="det-act">Act {d.act}</span>}
                </div>
                <div className="det-detail">
                  {d.message}
                  {d.rfLevelA != null && <span className="det-rf"> · RF {d.rfLevelA}/{d.rfLevelB ?? '—'}</span>}
                </div>
                {noteFor === d.id ? (
                  <div className="det-note-edit">
                    <input
                      className="det-note-input"
                      value={noteDraft}
                      onChange={e => setNoteDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveNote(); if (e.key === 'Escape') setNoteFor(null); }}
                      placeholder="What was happening?"
                      autoFocus
                    />
                    <button className="btn-text-primary" onClick={saveNote}>Save</button>
                  </div>
                ) : d.note ? (
                  <div className="det-note" onClick={() => openNote(d)} title="Edit note">{d.note}</div>
                ) : (
                  <button className="det-note-add" onClick={() => openNote(d)}>Add a note</button>
                )}
              </div>

              <div className="det-audio">
                {d.clipPath ? (
                  <audio controls preload="none" src={clipUrl(d.id)} className="det-player" />
                ) : (
                  <span className="det-noclip">
                    {d.clipBytes === 0 && d.clipMs > 0
                      ? 'Clip pruned for space'
                      : 'No audio — channel not patched, or still recording'}
                  </span>
                )}
              </div>

              <div className="det-actions">
                <button
                  className={`btn-icon ${d.flagged ? 'is-flagged' : ''}`}
                  onClick={() => setFlagged(d.id, !d.flagged)}
                  title={d.flagged ? 'Unflag — the clip becomes prunable again' : 'Flag — keep this clip'}
                >
                  <Flag size={14} />
                </button>
                {!d.dismissed && (
                  <button className="btn-icon" onClick={() => dismiss(d.id)} title="Dismiss — keeps the record, clears the list">
                    <X size={14} />
                  </button>
                )}
                <button
                  className="btn-icon danger"
                  onClick={() => {
                    if (window.confirm('Delete this detection and its clip permanently?')) remove(d.id);
                  }}
                  title="Delete permanently"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
