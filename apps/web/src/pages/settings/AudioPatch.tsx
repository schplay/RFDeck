import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useAudioPatch } from '../../hooks/useAudioPatch';
import { useActiveChannels } from '../../hooks/useActiveChannels';
import { channelKey as keyFor } from '../../lib/channelKey';

// Patch RF channels to audio inputs on the machine running RFDeck.
//
// Everything here is driven by what the server actually reports: however many
// interfaces are attached, and however many inputs each one has. Nothing
// assumes a stereo box, a single device, or a particular rig — an installation
// might have a 2-channel USB interface, a 32-channel Dante card, the virtual
// RAVENNA device the AES67 daemon creates, or several at once.

export function AudioPatchSettings() {
  const channels = useActiveChannels();
  const { devices, assignments, hint, loading, error, patch, reload } = useAudioPatch();

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3>Audio Patch</h3>
        <button className="btn-icon" onClick={() => reload(true)} title="Rescan devices" disabled={loading}>
          <RefreshCw size={14} />
        </button>
      </div>
      <p className="settings-desc">
        Which input each channel is wired to on the machine running RFDeck.
        Monitoring streams from there, so the patch is the same for everyone
        rather than something each device configures for itself.
      </p>

      {error && <p className="settings-desc settings-warn">{error}</p>}

      {loading ? (
        <p className="settings-desc">Scanning the server for audio devices…</p>
      ) : devices.length === 0 ? (
        <div className="settings-notice">
          <p className="settings-desc settings-warn" style={{ marginBottom: 8 }}>
            <strong>No capture devices found on the server.</strong>
          </p>
          <p className="settings-desc">{hint}</p>
        </div>
      ) : channels.length === 0 ? (
        <p className="settings-desc settings-warn">
          No channels are online yet. Connect receivers in Inventory, then patch them here.
        </p>
      ) : (
        <>
          <div className="audio-patch-devices">
            {devices.map(d => (
              <span
                key={d.id}
                className="audio-patch-chip"
                title={d.channelsProbed
                  ? undefined
                  : 'RFDeck could not read this device’s channel count and is ' +
                    'assuming ' + d.channels + '. Run "rfdeck audio-devices" on the server.'}
              >
                {d.label} · {d.channels} in{d.channelsProbed ? '' : '?'}
              </span>
            ))}
          </div>

          <div className="audio-patch-table">
            <div className="audio-patch-head">
              <span>Channel</span>
              <span>Interface</span>
              <span>Input</span>
            </div>

            {channels.map(ch => {
              const key = keyFor(ch);
              const current = assignments[key];
              const device = devices.find(d => d.id === current?.deviceId);
              // Build the input list from the selected device's real width.
              const inputCount = device?.channels ?? 0;

              return (
                <div key={ch.id} className="audio-patch-row">
                  <span className="audio-patch-name">{ch.name || `CH ${ch.channelIndex}`}</span>

                  <select
                    className="sm-select"
                    value={current?.deviceId ?? ''}
                    onChange={e => {
                      const id = e.target.value || null;
                      // Default to input 1 so choosing a device is one action.
                      patch(key, id, id ? 1 : null);
                    }}
                  >
                    <option value="">— not patched —</option>
                    {devices.map(d => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>

                  <select
                    className="sm-select"
                    value={current?.inputChannel ?? ''}
                    disabled={!current}
                    onChange={e => patch(key, current!.deviceId, Number(e.target.value))}
                  >
                    {!current && <option value="">—</option>}
                    {Array.from({ length: inputCount }, (_, i) => i + 1).map(n => (
                      <option key={n} value={n}>Input {n}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
