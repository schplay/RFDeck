import React, { useEffect, useState } from 'react';
import { Channel } from '@rfdeck/shared-types';
import { Headphones, VolumeX, Disc } from 'lucide-react';
import { useChannelCapture } from '../../hooks/useChannelCapture';
import { useUiStore, LOCKED_REASON } from '../../stores/uiStore';
import { useSocket } from '../../hooks/useSocket';
import { useChannelAudio } from '../../hooks/useChannelAudio';
import { channelKey } from '../../lib/channelKey';
import './ChannelActions.css';

/**
 * Mute, Listen and Capture for one channel.
 *
 * One component rather than one per view. The list view used to draw its own
 * pair of buttons that were wired to nothing at all and knew nothing about the
 * mute lock, the listen bus or capture — so switching from Grid to List
 * silently took away controls that looked like they were there. Anything that
 * shows a channel now gets the same three buttons and the same behaviour.
 */
interface ChannelActionsProps {
  channel: Channel;
  /** Icon-only buttons for tight rows; the labels stay in the tooltips. */
  compact?: boolean;
  /** Offline devices accept no commands. */
  disabled?: boolean;
}

export const ChannelActions: React.FC<ChannelActionsProps> = ({
  channel, compact = false, disabled = false,
}) => {
  const { socket, isConnected } = useSocket();
  const { listen, stop, toggle, listening, error: audioError } = useChannelAudio();
  const audioKey = channelKey(channel);
  const isListening = listening.includes(audioKey);
  const busHasOthers = listening.some(k => k !== audioKey);

  // Either lock is enough: the mute lock is the narrow one, the surface lock
  // is the show-time one that covers everything. Both selectors run every
  // render — combining them with `||` across two hook calls would make the
  // hook count depend on the lock state.
  const muteLockEngaged = useUiStore(s => s.mutesLocked);
  const surfaceLocked = useUiStore(s => s.surfaceLocked);
  const mutesLocked = muteLockEngaged || surfaceLocked;

  const { capture, error: captureError, clearError: clearCaptureError,
          start: startCaptureFor, stop: stopCaptureFor } = useChannelCapture(channel);
  const [capturePick, setCapturePick] = useState(false);

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

  const handleMuteToggle = () => {
    if (socket && isConnected) {
      socket.emit('channel:mute', {
        deviceId: channel.deviceId,
        rxIndex: channel.channelIndex,
        muted: !channel.isMuted,
      });
    }
  };

  const handleListen = (e: React.MouseEvent) => {
    // Plain click solos — this channel and nothing else. Shift-click stacks it
    // onto whatever is already playing, the way shift-click works on a console.
    if (e.shiftKey) { void toggle(audioKey); return; }
    if (isListening && !busHasOthers) stop();
    else listen(audioKey);
  };

  const muteLabel = channel.isMuted ? 'Unmute' : 'Mute';
  const listenLabel = isListening ? 'Stop' : 'Listen';

  // Rows stop at the buttons; cards carry the reason a button refused.
  const label = (text: string) =>
    compact ? null : <span className="cs-btn-label">{text}</span>;

  return (
    <>
      <div className={`cs-actions ${compact ? 'is-compact' : ''}`}>
        <button
          className="cs-btn btn-secondary"
          onClick={handleMuteToggle}
          disabled={mutesLocked || disabled}
          title={mutesLocked
            ? (surfaceLocked ? LOCKED_REASON : 'Mute controls are locked — unlock them from the dashboard toolbar')
            : `${muteLabel} this channel`}
          aria-label={muteLabel}
        >
          <VolumeX size={14} />{label(muteLabel)}
        </button>

        {/* Listening is the emphasised state; idle is the quiet one. */}
        <button
          className={`cs-btn ${isListening ? 'btn-primary is-listening' : 'btn-secondary'}`}
          onClick={handleListen}
          disabled={disabled}
          title={audioError ?? (isListening
            ? (busHasOthers ? 'Listen to this channel alone · Shift-click to take it off the bus' : 'Stop listening')
            : 'Listen to this channel · Shift-click to add it to what is playing')}
          aria-pressed={isListening}
          aria-label={listenLabel}
        >
          <Headphones size={14} />{label(listenLabel)}
        </button>

        {/* Keep the next N minutes of this channel, starting from the pre-roll
            already in memory. Not behind the surface lock: it changes nothing
            about the rig, it only remembers it. */}
        {capture ? (
          <button
            className="cs-btn btn-secondary is-capturing"
            onClick={() => void stopCaptureFor()}
            title={`Capturing until ${new Date(capture.endsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}. Click to stop and keep what was recorded.`}
            aria-label="Stop capture"
          >
            <Disc size={14} />{label('Stop')}
          </button>
        ) : capturePick ? (
          <span className="cs-capture-pick" role="group" aria-label="Capture length">
            {[1, 5, 15, 60].map(m => (
              <button
                key={m}
                className="cs-btn btn-secondary"
                onClick={() => { setCapturePick(false); void startCaptureFor(m); }}
              >
                {m} min
              </button>
            ))}
            <button className="cs-btn btn-secondary" onClick={() => setCapturePick(false)} aria-label="Cancel">✕</button>
          </span>
        ) : (
          <button
            className="cs-btn btn-secondary"
            onClick={() => { clearCaptureError(); setCapturePick(true); }}
            disabled={disabled}
            title="Record the next few minutes of this channel, pre-roll included"
            aria-label="Capture"
          >
            <Disc size={14} />{label('Capture')}
          </button>
        )}
      </div>

      {!compact && captureError && (
        <div className="cs-control-error" role="status">{captureError}</div>
      )}
      {!compact && (controlError || (isListening && audioError)) && (
        <div className="cs-control-error" role="status">
          {controlError ?? audioError}
        </div>
      )}
    </>
  );
};
