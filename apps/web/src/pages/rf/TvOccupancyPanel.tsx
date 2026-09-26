import React, { useEffect, useState } from 'react';
import { Tv, RefreshCw, MapPin, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { API_BASE, apiFetch } from '../../lib/api';
import './TvOccupancyPanel.css';

/**
 * Which TV channels are licensed at this venue, and how stale that answer is.
 *
 * The staleness is not a detail. The data is cached so it works offline, which
 * means it can be months old without anything looking wrong — and a coordination
 * plan built on a stale pack is exactly the kind of thing an operator should be
 * able to see rather than have to trust.
 */

interface Occupancy {
  exclusions: Array<{
    rfChannel: number;
    rangeKHz: [number, number];
    stations: { callSign: string | null; service: string | null }[];
  }> | null;
  unmapped: number[];
  source: 'cache' | 'network' | 'none';
  oldestFetchedAt: string | null;
  cellsUsed: string[];
  reason: string | null;
}

function ageOf(iso: string | null): { text: string; stale: boolean } | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return null;
  // Meros republishes weekly, so a fortnight means the rig has not been online in
  // a while — worth flagging without crying wolf.
  return {
    text: days === 0 ? 'updated today' : days === 1 ? 'updated yesterday' : `updated ${days} days ago`,
    stale: days > 14,
  };
}

export function TvOccupancyPanel() {
  const [data, setData] = useState<Occupancy | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch(`${API_BASE}/cloud/tv-occupancy`)
      .then(r => r.json())
      .then(setData)
      .catch(() => setData(null));
  };

  useEffect(load, []);

  const refresh = async () => {
    setBusy(true);
    try {
      setData(await apiFetch('/cloud/tv-occupancy/refresh', { method: 'POST' }) as Occupancy);
    } catch {
      /* the reason already on screen still applies */
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;

  const age = ageOf(data.oldestFetchedAt);
  const excluded = data.exclusions ?? [];

  return (
    <div className="rf-card sidebar-card">
      <div className="sidebar-section-title">
        <Tv size={13} /> Licensed TV channels
      </div>

      {/* No data is its own state, and it says what to do about it. Showing
          "0 channels" here would be a claim about the spectrum rather than about
          what RFDeck knows, which is a different and much worse thing to say. */}
      {!data.exclusions ? (
        <>
          <p className="tvo-reason">{data.reason ?? 'No regional data available.'}</p>
          {data.reason?.includes('venue location') && (
            <Link to="/settings?tab=cloud" className="tvo-link">
              <MapPin size={12} /> Set the venue location
            </Link>
          )}
        </>
      ) : (
        <>
          <div className="tvo-summary">
            <span className="tvo-count">{excluded.length}</span>
            <span className="tvo-count-label">
              {excluded.length === 1 ? 'channel in use here' : 'channels in use here'}
            </span>
          </div>

          {excluded.length > 0 && (
            <ul className="tvo-list">
              {excluded.map(e => (
                <li key={e.rfChannel} className="tvo-row">
                  <span className="tvo-ch">CH {e.rfChannel}</span>
                  <span className="tvo-mhz">
                    {(e.rangeKHz[0] / 1000).toFixed(0)}–{(e.rangeKHz[1] / 1000).toFixed(0)} MHz
                  </span>
                  {/* The station is the answer to "why can I not use that?" */}
                  <span className="tvo-who">
                    {e.stations.map(s => s.callSign).filter(Boolean).join(', ') || '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {excluded.length === 0 && (
            <p className="tvo-reason">
              No licensed TV stations cover this location, on the data downloaded.
            </p>
          )}

          {/* A channel the plan could not map is the one thing here that must not
              be silent: it means a licensed channel RFDeck knows about but cannot
              turn into an exclusion. */}
          {data.unmapped.length > 0 && (
            <p className="tvo-warn">
              <AlertTriangle size={12} />
              Channel {data.unmapped.join(', ')} could not be mapped to a frequency
              range, so it is <strong>not</strong> being excluded. Coordinate around
              it by hand.
            </p>
          )}

          <div className="tvo-foot">
            {age && (
              <span className={age.stale ? 'tvo-stale' : undefined}>
                {age.text}
                {age.stale && ' — connect to the internet to refresh'}
              </span>
            )}
            <button className="tvo-refresh" onClick={() => void refresh()} disabled={busy}
                    title="Download the latest data for this location">
              <RefreshCw size={12} className={busy ? 'tvo-spin' : undefined} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
