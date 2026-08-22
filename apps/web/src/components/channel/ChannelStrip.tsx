import React from 'react';
import { Card } from '../ui/Card';
import { Channel } from '@rfdeck/shared-types';
import { Mic, Headphones, AlertTriangle, AlertCircle, VolumeX, WifiOff } from 'lucide-react';
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
  const isOutput = deviceType === 'output';

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
    <Card statusBorder={statusBorder} className={`channel-strip ${channel.isMuted ? 'is-muted' : ''}`}>
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
        <button className="cs-btn btn-secondary" onClick={handleMuteToggle}>
          <VolumeX size={14} /> {channel.isMuted ? 'Unmute' : 'Mute'}
        </button>
        <button
          className={`cs-btn ${isListening ? 'btn-active' : 'btn-primary'}`}
          onClick={handleListen}
          title={audioError ?? (isListening ? 'Stop listening' : 'Listen to this channel')}
        >
          <Headphones size={14} /> {isListening ? 'Stop' : 'Listen'}
        </button>
      </div>
    </Card>
  );
});
