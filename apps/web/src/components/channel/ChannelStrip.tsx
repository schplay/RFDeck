import React, { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { Channel } from '@rfdeck/shared-types';
import { Mic, Headphones, AlertTriangle, AlertCircle, VolumeX, WifiOff } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { useSocket } from '../../hooks/useSocket';
import { useChannelAudio } from '../../hooks/useChannelAudio';
import { channelKey } from '../../lib/channelKey';
import './ChannelStrip.css';

interface ChannelStripProps {
  channel: Channel;
  deviceType?: 'input' | 'output';
  deviceOnline?: boolean;
}

export const ChannelStrip: React.FC<ChannelStripProps> = React.memo(({ channel, deviceType = 'input', deviceOnline = true }) => {
  const { socket, isConnected } = useSocket();
  // Audio is captured on the server and streamed here, so this works from any
  // client rather than only from a browser sitting at the interface.
  const { listen, stop, listeningTo, error: audioError } = useChannelAudio();
  const audioKey = channelKey(channel);
  const isListening = listeningTo === audioKey;
  // Global safety switch from the dashboard toolbar; applies on every view
  // that renders a strip, Backstage included.
  const mutesLocked = useUiStore(s => s.mutesLocked);

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

  // Helper to render segmented meter
  const renderMeter = (level: number, type: 'rf' | 'af') => {
    const segments = 10;
    const activeCount = Math.floor((level / 100) * segments);
    return (
      <div className="meter-stack">
        {Array.from({ length: segments }).map((_, i) => {
          const index = segments - 1 - i;
          const isActive = index < activeCount;
          let colorClass = 'meter-segment';
          if (isActive) {
            if (type === 'rf') {
              if (index < 2) colorClass += ' active-red';
              else if (index < 4) colorClass += ' active-orange';
              else colorClass += ' active-green';
            } else {
              if (index >= 8) colorClass += ' active-red';
              else if (index >= 6) colorClass += ' active-orange';
              else colorClass += ' active-green';
            }
          }
          return <div key={i} className={colorClass} />;
        })}
      </div>
    );
  };

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

  const handleListen = () => {
    // The server resolves which input this channel is patched to, so the
    // client only has to name the channel.
    if (isListening) stop();
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
            ? 'Mute controls are locked — unlock them from the dashboard toolbar'
            : (channel.isMuted ? 'Unmute this channel' : 'Mute this channel')}
        >
          <VolumeX size={14} /> {channel.isMuted ? 'Unmute' : 'Mute'}
        </button>
        {/* Listening is the emphasised state; idle is the quiet one. It used
            to be the reverse, because "btn-active" had no styling at all. */}
        <button
          className={`cs-btn ${isListening ? 'btn-primary is-listening' : 'btn-secondary'}`}
          onClick={handleListen}
          title={audioError ?? (isListening ? 'Stop listening' : 'Listen to this channel')}
          aria-pressed={isListening}
        >
          <Headphones size={14} /> {isListening ? 'Stop' : 'Listen'}
        </button>
      </div>
      {(controlError || (isListening && audioError)) && (
        <div className="cs-control-error" role="status">
          {controlError ?? audioError}
        </div>
      )}
    </Card>
  );
});
