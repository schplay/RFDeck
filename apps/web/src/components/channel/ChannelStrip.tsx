import React from 'react';
import { Card } from '../ui/Card';
import { Channel } from '@rfdeck/shared-types';
import { Mic, Headphones, WifiOff } from 'lucide-react';
import { useSocket } from '../../hooks/useSocket';
import { ChannelActions } from './ChannelActions';
import { useIntermodStore, IntermodHit } from '../../stores/intermodStore';
import { Meter } from '../meters/Meter';
import { channelStatus, channelPlace, batteryTone } from '../../lib/channelStatus';
import { useBatteryThresholds } from '../../stores/batteryStore';
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
  /** The receiver's inventory name, for the "Vocal rack · Ch 3" line. */
  deviceName?: string | null;
  /** No recent telemetry for this channel. */
  stale?: boolean;
}

export const ChannelStrip: React.FC<ChannelStripProps> = React.memo(({ channel, deviceType = 'input', deviceOnline = true, deviceName, stale = false }) => {
  const { socket, isConnected } = useSocket();
  // Products from the rig's own transmitters that land on this channel.
  const imHits = useIntermodStore(s => s.report.hits.filter(h => h.victimId === channel.id));

  // The channel now says what it is, server-side. The prop is kept as a
  // fallback for callers that still pass it, but the channel wins: it is the
  // same answer the server used when deciding whether to alert on this
  // channel's RF, and the two must not be able to disagree.
  const isOutput = channel.role === 'iem' || deviceType === 'output';

  // One answer for "is this channel a problem", shared with the list, the
  // dense grid, the Micboard and Backstage. A healthy card stays neutral: with
  // every card outlined in green, the one that needed attention did not stand
  // out from the thirty that did not.
  const thresholds = useBatteryThresholds();
  const status = channelStatus(channel, deviceOnline, stale, thresholds);
  const statusBorder = status.tone === 'crit' ? 'error'
                     : status.tone === 'warn' ? 'warning' : 'default';
  const place = channelPlace(channel, deviceName);

  // The shared meter, with this card's segment count. Thresholds, ballistics,
  // peak hold and colours all come from the meter settings rather than being
  // decided here — this card used to turn RF red at 20% while the server
  // alerts at 25%, and nobody had chosen either.
  const renderMeter = (level: number, type: 'rf' | 'af') => (
    <Meter value={level} kind={type} segments={10} orientation="vertical" className="meter-stack" />
  );

  // Quiet when fine: the role icon in gray. Otherwise the one word that says
  // what is wrong, in the color of how wrong it is.
  const StatusMark = () => status.tone === 'good'
    ? (isOutput
        ? <Headphones size={18} className="text-muted" aria-label="IEM transmitter" />
        : <Mic size={18} className="text-muted" aria-label="Microphone" />)
    : <span className={`cs-status cs-status-${status.tone}`}>{status.label}</span>;

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
            <p className="cs-subtitle">{place}</p>
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
          <p className="cs-subtitle">{place}</p>
        </div>
        <StatusMark />
      </div>

      <div className="cs-body">
        <div className="cs-meters">
          {/* Each meter labeled underneath, where the eye lands after the
              level — A and B are the two diversity antennas. */}
          <div className="cs-meter-col">
            {renderMeter(channel.rfLevelA, 'rf')}
            <span className="cs-meter-tag">{isOutput ? 'TX' : 'A'}</span>
          </div>
          <div className="cs-meter-col">
            {renderMeter(channel.rfLevelB, 'rf')}
            <span className="cs-meter-tag">{isOutput ? '' : 'B'}</span>
          </div>
          <div className="meter-spacer" />
          <div className="cs-meter-col">
            {renderMeter(channel.afLevel, 'af')}
            <span className="cs-meter-tag">{isOutput ? 'MON' : 'AF'}</span>
          </div>
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
          <div className={`cs-batt batt-${batteryTone(channel.batteryPercent, thresholds)}`}>
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
