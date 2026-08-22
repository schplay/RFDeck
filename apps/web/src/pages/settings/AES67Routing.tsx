import React from 'react';
import { RefreshCw, Link2, Unlink } from 'lucide-react';
import { useAES67 } from '../../hooks/useAES67';

// Route AES67 streams into this server without leaving RFDeck.
//
// The AES67 daemon has its own web UI for this, but it runs on a separate port
// that a rack server may not be publishing, and it talks about sinks and SDP
// rather than about the channels an operator is actually working with. This
// does the same job in RFDeck's vocabulary.

export function AES67RoutingSettings() {
  const { status, loading, busy, error, reload, subscribe, unsubscribe, subscribeAll } = useAES67();

  const sources = status?.sources ?? [];
  const unsubscribed = sources.filter(s => !s.subscribed).length;

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3>AES67 Network Audio</h3>
        <button className="btn-icon" onClick={reload} title="Rescan the network" disabled={loading}>
          <RefreshCw size={14} />
        </button>
      </div>
      <p className="settings-desc">
        Audio senders announcing themselves on the network. Receiving one routes
        it to inputs on this server, which you then patch to RF channels in
        Audio Patch.
      </p>

      {error && <p className="settings-desc settings-warn">{error}</p>}

      {loading && !status ? (
        <p className="settings-desc">Looking for AES67 senders…</p>
      ) : !status?.available ? (
        <div className="settings-notice">
          <p className="settings-desc settings-warn" style={{ marginBottom: 8 }}>
            <strong>AES67 is not available on this machine.</strong>
          </p>
          <p className="settings-desc">{status?.reason}</p>
        </div>
      ) : (
        <>
          <div className="audio-patch-devices">
            {status.device ? (
              <span className="audio-patch-chip">
                {status.device.label} · {status.device.channels} in
              </span>
            ) : (
              <span className="audio-patch-chip settings-warn">No RAVENNA device</span>
            )}
            {status.ptp?.status && (
              <span
                className="audio-patch-chip"
                title={status.ptp.gmid ? `Grandmaster ${status.ptp.gmid}` : undefined}
              >
                PTP {status.ptp.status}
              </span>
            )}
          </div>

          {sources.length === 0 ? (
            <p className="settings-desc">
              No senders are announcing themselves yet. They appear here once a
              transmitter is advertising over SAP or mDNS on this network — check
              the sender has an AES67 flow enabled, and that UDP 9875 is open
              between it and this server.
            </p>
          ) : (
            <>
              {unsubscribed > 1 && (
                <button
                  className="btn-secondary"
                  onClick={subscribeAll}
                  disabled={busy !== null}
                  style={{ marginBottom: 12 }}
                >
                  Receive all {unsubscribed} remaining
                </button>
              )}

              <table className="settings-table">
                <thead>
                  <tr>
                    <th>Sender</th>
                    <th>Found via</th>
                    <th>Channels</th>
                    <th>Inputs</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sources.map(s => (
                    <tr key={s.id}>
                      <td>
                        {s.name}
                        {s.address && <span className="settings-dim"> · {s.address}</span>}
                      </td>
                      <td className="settings-dim">{s.via?.toUpperCase()}</td>
                      <td>
                        {/* Null means the SDP did not say; the server will not
                            invent a width, so neither does the display. */}
                        {s.channels ?? <span className="settings-warn" title="Not stated in the sender's SDP">unknown</span>}
                      </td>
                      <td className="settings-dim">
                        {s.subscribed && s.inputChannels.length > 0
                          ? formatRange(s.inputChannels)
                          : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {s.subscribed ? (
                          <button
                            className="btn-icon"
                            title="Stop receiving"
                            disabled={busy !== null}
                            onClick={() => s.sinkId !== null && unsubscribe(s.sinkId)}
                          >
                            <Unlink size={14} />
                          </button>
                        ) : (
                          <button
                            className="btn-icon"
                            title="Receive this sender"
                            disabled={busy !== null || s.channels === null}
                            onClick={() => subscribe(s.id)}
                          >
                            <Link2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}

// "1-8" reads better than "1, 2, 3, 4, 5, 6, 7, 8" for a contiguous block,
// which is what allocation always produces.
function formatRange(channels: number[]): string {
  if (channels.length === 0) return '—';
  if (channels.length === 1) return String(channels[0]);
  const first = channels[0];
  const last = channels[channels.length - 1];
  const contiguous = last - first + 1 === channels.length;
  return contiguous ? `${first}-${last}` : channels.join(', ');
}
