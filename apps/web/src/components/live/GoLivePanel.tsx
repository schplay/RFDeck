import React, { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { useLiveStore } from '../../stores/liveStore';
import { useShowStore } from '../../stores/showStore';
import { useDeviceStore } from '../../stores/deviceStore';
import './GoLivePanel.css';

// The one thing to do when you sit down: tell RFDeck you are working the rig.
//
// Deliberately the whole screen rather than a control among controls. Until
// this is pressed the dashboard has nothing on it — every device is disabled —
// and an empty dashboard with a small button somewhere is a puzzle. This is
// the answer to "why is nothing here".

export function GoLivePanel() {
  const { goLive, busy, error } = useLiveStore();
  const { shows, fetchShows, loaded } = useShowStore();
  const inventory = useDeviceStore(s => s.inventory);

  const [showId, setShowId] = useState<string>('');

  useEffect(() => { if (!loaded) void fetchShows(); }, [loaded, fetchShows]);

  const candidates = shows.filter(s => !s.archived);

  // Preselect when there is no real choice to make.
  useEffect(() => {
    if (!showId && candidates.length === 1) setShowId(candidates[0].id);
  }, [candidates.length, showId]);

  return (
    <div className="gl-root">
      <div className="gl-card">
        <h1 className="gl-title">Ready when you are</h1>
        <p className="gl-sub">
          Going live starts tracking every device in the inventory, begins
          recording and fault detection, and puts the cast on the Micboard.
        </p>

        {candidates.length > 0 && (
          <label className="gl-show">
            <span className="gl-show-label">Show</span>
            <select
              className="gl-select"
              value={showId}
              onChange={e => setShowId(e.target.value)}
              disabled={busy}
            >
              <option value="">No show — rehearsal or one-off</option>
              {candidates.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <span className="gl-show-hint">
              {showId
                ? 'The Micboard will show this cast.'
                : 'The Micboard will show channel names rather than performers.'}
            </span>
          </label>
        )}

        <button
          className="gl-button"
          onClick={() => goLive(showId || null)}
          disabled={busy}
        >
          <Radio size={22} />
          {busy ? 'Going live…' : 'Go Live'}
        </button>

        {error && <p className="gl-error">{error}</p>}

        <p className="gl-foot">
          {inventory.length === 0
            ? 'No devices in the inventory yet — add hardware first, in Inventory.'
            : `${inventory.length} device${inventory.length === 1 ? '' : 's'} will start being tracked.`}
        </p>
      </div>
    </div>
  );
}
