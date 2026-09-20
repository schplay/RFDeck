import React from 'react';
import { Card } from '../ui/Card';
import { Channel } from '@rfdeck/shared-types';
import { Mic, Headphones, AlertTriangle, AlertCircle, VolumeX, WifiOff } from 'lucide-react';
import { useSocket } from '../../hooks/useSocket';
import { ChannelActions } from './ChannelActions';
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
  // Products from the rig's own transmitters that land on this channel.
  const imHits = useIntermodStore(s => s.report.hits.filter(h => h.victimId === channel.id));

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

      <div className="cs-meta-row">
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
      </div>

      <ChannelActions channel={channel} />
    </Card>
  );
});
