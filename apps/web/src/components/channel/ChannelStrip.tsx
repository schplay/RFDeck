import React, { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { Channel } from '@rfdeck/shared-types';
import { Mic, Headphones, AlertTriangle, AlertCircle, VolumeX, WifiOff, Disc } from 'lucide-react';
import { useChannelCapture } from '../../hooks/useChannelCapture';
import { useUiStore, LOCKED_REASON } from '../../stores/uiStore';
import { useSocket } from '../../hooks/useSocket';
import { useChannelAudio } from '../../hooks/useChannelAudio';
import { channelKey } from '../../lib/channelKey';
import { useIntermodStore, IntermodHit } from '../../stores/intermodStore';
import { Meter } from '../meters/Meter';
import './ChannelStrip.css';

/**
 * What to say about intermodulation landing on this channel.
 *
 * Names the transmitters responsible rather than just announcing a problem: a
 * warning an operator cannot act on is one they learn to ignore, and the action
 * here is always "move one of these two".
 */
function intermodTitle(hits: IntermodHit[]): string {
  const lines = hits.slice(0, 4).map(h =>
    `  ${h.formula} — ${h.offsetKHz === 0 ? 'dead on' : `${Math.abs(h.offsetKHz)} kHz away`}`,
  );
  const more = hits.length > 4 ? [`  …and ${hits.length - 4} more`] : [];
  return [
    'Intermodulation from this rig lands on this channel:',
    ...lines,
    ...more,
    '',
    'Moving either transmitter that makes it will clear it.',
  ].join('\n');
}

interface ChannelStripProps {
  channel: Channel;
  deviceType?: 'input' | 'output';
  deviceOnline?: boolean;
}

export const ChannelStrip: React.FC<ChannelStripProps> = React.memo(({ channel, deviceType = 'input', deviceOnline = true }) => {
  const { socket, isConnected } = useSocket();
  // Audio is captured on the server and streamed here, so this works from any
  // client rather than only from a browser sitting at the interface.
  const { listen, stop, toggle, listening, error: audioError } = useChannelAudio();
  const audioKey = channelKey(channel);
  const isListening = listening.includes(audioKey);
  const busHasOthers = listening.some(k => k !== audioKey);
  // Global safety switch from the dashboard toolbar; applies on every view
  // that renders a strip, Backstage included.
  // Either lock is enough. The mute lock is the narrow, always-on one; the
  // surface lock is the show-time one that covers everything.
  const mutesLocked = useUiStore(s => s.mutesLocked) || useUiStore(s => s.surfaceLocked);
  const surfaceLocked = useUiStore(s => s.surfaceLocked);
  // Products from the rig's own transmitters that land on this channel.
  const imHits = useIntermodStore(s => s.report.hits.filter(h => h.victimId === channel.id));

  // Capture on request, shared with the context menu so there is one way to
  // start and stop one. The running state is the server's: a capture started
  // at FOH is running backstage too.
  const { capture, error: captureError, clearError: clearCaptureError,
          start: startCaptureFor, stop: stopCaptureFor } = useChannelCapture(channel);
  const [capturePick, setCapturePick] = useState(false);
  const startCapture = (minutes: number) => { setCapturePick(false); void startCaptureFor(minutes); };
  const stopCapture = (_detectionId: string) => { void stopCaptureFor(); };

  // Outcome of the last control command for THIS channel. A refused command
  // otherwise leaves the button looking inert, with the reason only in the
  // server log.
  const [controlError, setControlError] = useState<string | null>(null);
  useEffect(() => {
    if (!socket) return;
    const onResult = (r: { deviceId: string; rxIndex: number; ok: boolean; message: string | null }) => {
      if (r.deviceId !== channel.deviceId || r.rxIndex !== channel.channelIndex) return;
      setControlError(r.ok ? null : r.message);
    };
    socket.on('control:result', onResult);
    return () => { socket.off('control:result', onResult); };
  }, [socket, channel.deviceId, channel.channelIndex]);
  useEffect(() => {
    if (!controlError) return;
    const t = setTimeout(() => setControlError(null), 8_000);
    return () => clearTimeout(t);
  }, [controlError]);
  // The channel now says what it is, server-side. The prop is kept as a
  // fallback for callers that still pass it, but the channel wins: it is the
  // same answer the server used when deciding whether to alert on this
  // channel's RF, and the two must not be able to disagree.
  const isOutput = channel.role === 'iem' || deviceType === 'output';

  const statusBorder = !deviceOnline ? 'error'
                     : channel.status === 'ACTIVE' ? 'success'
                     : channel.status === 'WARNING' ? 'warning' : 'error';

  // The shared meter, with this card's segment count. Thresholds, ballistics,
  // peak hold and colours all come from the meter settings rather than being
  // decided here — this card used to turn RF red at 20% while the server
  // alerts at 25%, and nobody had chosen either.
  const renderMeter = (level: number, type: 'rf' | 'af') => (
    <Meter value={level} kind={type} segments={10} orientation="vertical" className="meter-stack" />
  );

  const StatusIcon = () => {
    if (!deviceOnline) return <WifiOff size={18} className="text-muted" />;
    if (channel.status === 'CRITICAL') return <AlertCircle size={18} className="text-error" />;
    // A performer's own mute switch is a state, not a problem — showing a
    // warning triangle for it sent operators hunting for a fault.
    if (channel.isTxMuted) return <VolumeX size={18} className="text-muted" aria-label="Muted at the transmitter" />;
    if (channel.status === 'WARNING') return <AlertTriangle size={18} className="text-warning" />;
    return isOutput
      ? <Headphones size={18} className="text-primary" />
      : <Mic size={18} className="text-primary" />;
  };

  const handleMuteToggle = () => {
    if (socket && isConnected) {
      socket.emit('channel:mute', {
        deviceId: channel.deviceId,
        rxIndex: channel.channelIndex,
        muted: !channel.isMuted
      });
    }
  };

  const handleListen = (e: React.MouseEvent) => {
    // The server resolves which input this channel is patched to, so the
    // client only has to name the channel.
    //
    // Plain click solos — this channel and nothing else — because that is what
    // "Listen" has always meant here. Shift-click stacks it onto whatever is
    // already playing, the way shift-click works on a console.
    if (e.shiftKey) { void toggle(audioKey); return; }
    if (isListening && !busHasOthers) stop();
    else listen(audioKey);
  };

  // Offline overlay — device disconnected, show stale data dimmed with a banner
  if (!deviceOnline) {
    return (
      <Card statusBorder="error" className="channel-strip is-offline">
        <div className="cs-offline-banner">
          <WifiOff size={13} />
          Device Offline
        </div>
        <div className="cs-header cs-header-dimmed">
          <div>
            <h3 className="cs-title">{channel.name || `CH ${channel.channelIndex}`}</h3>
            <p className="cs-subtitle">{channel.deviceId.split(':')[0]}</p>
          </div>
          {isOutput ? <Headphones size={18} className="text-muted" /> : <Mic size={18} className="text-muted" />}
        </div>
        <div className="cs-body cs-body-dimmed">
          <div className="cs-meters">
            {renderMeter(0, 'rf')}
            {renderMeter(0, 'rf')}
            <div className="meter-spacer" />
            {renderMeter(0, 'af')}
          </div>
          <div className="cs-data">
            <div className="cs-freq">
              <span className="freq-display">{channel.frequency > 0 ? (channel.frequency / 1000).toFixed(3) : '—'}</span>
              <span>MHz</span>
            </div>
            <div className="cs-batt">—%</div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card statusBorder={statusBorder} className={`channel-strip ${channel.isMuted || channel.isTxMuted ? 'is-muted' : ''}`}>
      <div className="cs-header">
        <div>
          <h3 className="cs-title">{channel.name || `CH ${channel.channelIndex}`}</h3>
          <p className="cs-subtitle">{channel.deviceId.split(':')[0]}</p>
        </div>
        <StatusIcon />
      </div>

      <div className="cs-body">
        <div className="cs-meters">
          <div className="meter-label">{isOutput ? 'TX' : 'A'}</div>
          {renderMeter(channel.rfLevelA, 'rf')}
          {renderMeter(channel.rfLevelB, 'rf')}
          <div className="meter-spacer" />
          <div className="meter-label">{isOutput ? 'MON' : 'AF'}</div>
          {renderMeter(channel.afLevel, 'af')}
        </div>

        <div className="cs-data">
          <div className="cs-freq">
            <span className="freq-display">
              {channel.frequency > 0 ? (channel.frequency / 1000).toFixed(3) : '—'}
            </span>
            <span>MHz</span>
            {/* Something in this rig is putting energy on this carrier. Shown
                against the frequency, because that is what would have to move
                to fix it, and on the card, because that is where the symptom —
                noise, or a dropout with no RF explanation — gets noticed. */}
            {imHits.length > 0 && (
              <span className="cs-im" title={intermodTitle(imHits)}>IM</span>
            )}
          </div>
          <div className={`cs-batt ${channel.batteryPercent && channel.batteryPercent <= 20 ? 'batt-low' : ''}`}>
            {channel.batteryPercent != null ? Math.round(channel.batteryPercent) : '--'}%
            <div className="batt-icon" />
          </div>
        </div>
      </div>

      <div className="cs-actions">
        <div className="cs-gain">
          <span className="gain-label">Gain</span>
          <input
            type="number"
            className="gain-input"
            defaultValue={channel.gain ?? 0}
            onBlur={(e) => {
              const val = parseInt(e.target.value);
              if (!isNaN(val) && socket && isConnected) {
                socket.emit('channel:gain', {
                  deviceId: channel.deviceId,
                  rxIndex: channel.channelIndex,
                  gain: val
                });
              }
            }}
          />
          <span className="gain-unit">dB</span>
        </div>
        <button
          className="cs-btn btn-secondary"
          onClick={handleMuteToggle}
          disabled={mutesLocked}
          title={mutesLocked
            ? (surfaceLocked ? LOCKED_REASON : 'Mute controls are locked — unlock them from the dashboard toolbar')
            : (channel.isMuted ? 'Unmute this channel' : 'Mute this channel')}
        >
          <VolumeX size={14} /> {channel.isMuted ? 'Unmute' : 'Mute'}
        </button>
        {/* Listening is the emphasised state; idle is the quiet one. It used
            to be the reverse, because "btn-active" had no styling at all. */}
        <button
          className={`cs-btn ${isListening ? 'btn-primary is-listening' : 'btn-secondary'}`}
          onClick={handleListen}
          title={audioError ?? (isListening
            ? (busHasOthers ? 'Listen to this channel alone · Shift-click to take it off the bus' : 'Stop listening')
            : 'Listen to this channel · Shift-click to add it to what is playing')}
          aria-pressed={isListening}
        >
          <Headphones size={14} /> {isListening ? 'Stop' : 'Listen'}
        </button>
        {/* Keep the next N minutes of this channel, starting from the pre-roll
            already in memory. Not behind the surface lock: it changes nothing
            about the rig, it only remembers it. */}
        {capture ? (
          <button
            className="cs-btn btn-secondary is-capturing"
            onClick={() => void stopCapture(capture.detectionId)}
            title={`Capturing until ${new Date(capture.endsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}. Click to stop and keep what was recorded.`}
          >
            <Disc size={14} /> Stop capture
          </button>
        ) : capturePick ? (
          <span className="cs-capture-pick" role="group" aria-label="Capture length">
            {[1, 5, 15, 60].map(m => (
              <button key={m} className="cs-btn btn-secondary" onClick={() => void startCapture(m)}>
                {m} min
              </button>
            ))}
            <button className="cs-btn btn-secondary" onClick={() => setCapturePick(false)} aria-label="Cancel">✕</button>
          </span>
        ) : (
          <button
            className="cs-btn btn-secondary"
            onClick={() => { clearCaptureError(); setCapturePick(true); }}
            title="Record the next few minutes of this channel, pre-roll included"
          >
            <Disc size={14} /> Capture
          </button>
        )}
      </div>
      {captureError && (
        <div className="cs-control-error" role="status">{captureError}</div>
      )}
      {(controlError || (isListening && audioError)) && (
        <div className="cs-control-error" role="status">
          {controlError ?? audioError}
        </div>
      )}
    </Card>
  );
});
