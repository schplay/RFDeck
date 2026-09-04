import React from 'react';
import { useLiveStore } from '../../stores/liveStore';
import './GoLivePanel.css';

// Persistent "we are live" state, with the way out of it.
//
// Standing down disables every device and stops recording, so it asks first
// and says what it will do — an accidental click mid-show would black out the
// dashboard and stop the capture that is the point of the thing.

export function LiveIndicator() {
  const { live, show, startedAt, standDown, busy } = useLiveStore();
  if (!live) return null;

  const since = startedAt
    ? new Date(startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : null;

  const confirm = () => {
    const detail = show ? `\n\nShow: ${show.name}` : '';
    if (window.confirm(
      'Stand down?\n\n' +
      'Every device stops being tracked, recording and fault detection stop, ' +
      'and the Micboard clears. Nothing is deleted.' + detail
    )) {
      void standDown();
    }
  };

  return (
    <div className="live-indicator">
      <div className="live-state">
        <span className="live-dot" aria-hidden />
        <div className="live-text">
          <span className="live-word">LIVE</span>
          <span className="live-meta">
            {show ? show.name : 'No show'}{since ? ` · since ${since}` : ''}
          </span>
        </div>
      </div>
      <button className="live-stand-down" onClick={confirm} disabled={busy}>
        {busy ? 'Standing down…' : 'Stand Down'}
      </button>
    </div>
  );
}
