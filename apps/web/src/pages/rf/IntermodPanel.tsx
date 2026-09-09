import React from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useIntermodStore } from '../../stores/intermodStore';

// Which of the rig's own frequencies are landing on each other.
//
// Two transmitters mixing in any non-linear stage they share produce third-order
// products near the original carriers — near enough to sit inside a receiver's
// front end. Coordination software works this out before a show from a plan
// somebody typed in; RFDeck works it out from the frequencies the receivers are
// actually on, which is the same calculation against better input. A plan stops
// being true the moment somebody re-tunes a pack at the rack.

function mhz(khz: number): string {
  return (khz / 1000).toFixed(3);
}

export function IntermodPanel() {
  const report = useIntermodStore(s => s.report);
  const { hits, truncated, sourceCount } = report;

  return (
    <div className="rf-card">
      <div className="rf-card-header">
        <div className="rf-card-title">
          {hits.length > 0
            ? <AlertTriangle size={16} className="card-icon im-icon-warn" />
            : <CheckCircle2 size={16} className="card-icon im-icon-ok" />}
          Intermodulation
        </div>
        <span className="table-count">
          {sourceCount} carrier{sourceCount === 1 ? '' : 's'}
        </span>
      </div>

      <div className="im-body">
        {sourceCount < 2 ? (
          <p className="im-note">
            Two or more transmitters have to be reporting a frequency before
            anything can mix.
          </p>
        ) : hits.length === 0 ? (
          <p className="im-note im-clear">
            No third-order product lands on a live channel. Checked every pair
            and triple of the {sourceCount} carriers currently on air.
          </p>
        ) : (
          <>
            <p className="im-note">
              {hits.length} product{hits.length === 1 ? '' : 's'} from the rig's own
              transmitters {hits.length === 1 ? 'lands' : 'land'} inside a live
              channel. Closest first — a product on top of a carrier is heard as
              noise or a dropout on that channel, and moving either transmitter
              that makes it will clear it.
            </p>

            <div className="im-table">
              {hits.slice(0, 12).map((h, i) => (
                <div key={`${h.victimId}-${h.formula}-${i}`} className="im-row">
                  <span className="im-victim">{h.victimName}</span>
                  <span className="im-offset">
                    {h.offsetKHz === 0 ? 'dead on' : `${h.offsetKHz > 0 ? '+' : ''}${h.offsetKHz} kHz`}
                  </span>
                  <span className="im-formula">{h.formula}</span>
                  <span className="im-product">{mhz(h.productKHz)} MHz</span>
                </div>
              ))}
            </div>

            {hits.length > 12 && (
              <p className="im-note">
                {hits.length - 12} more, all further out than these.
              </p>
            )}
          </>
        )}

        {/* Being told the answer is partial matters more than the answer. */}
        {truncated && (
          <p className="im-note im-warn">
            This rig is large enough that three-transmitter products were not
            searched — only pairs. The pair results above are complete.
          </p>
        )}
      </div>
    </div>
  );
}
