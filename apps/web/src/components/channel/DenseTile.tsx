import React from 'react';
import { Channel } from '@rfdeck/shared-types';
import { VolumeX, Headphones } from 'lucide-react';
import { Meter } from '../meters/Meter';
import { channelStatus } from '../../lib/channelStatus';
import { useIntermodStore } from '../../stores/intermodStore';
import './DenseTile.css';

// One channel, as small as it can be and still be read.
//
// The card dashboard is right for detail and wrong past thirty channels, where
// knowing the state of the rig means scrolling. This tile keeps only what an
// operator wants mid-show — is anything wrong, and on which channel — and
// drops everything that needs a second look. A hundred and twenty-eight of
// them fit on one screen.
//
// No controls. This is a view for reading, not operating; the actions live on
// the card and, later, in the context menu. Double-click still opens the
// device, as the card does.

interface Props {
  channel: Channel;
  online: boolean;
  stale: boolean;
  onOpen?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export function DenseTile({ channel, online, stale, onOpen, onContextMenu }: Props) {
  const { label, tone } = channelStatus(channel, online, stale);
  const isIem = channel.role === 'iem';
  const im = useIntermodStore(s => s.report.hits.some(h => h.victimId === channel.id));
  const dim = !online || stale;

  return (
    <div
      className={`dt dt-${tone} ${dim ? 'is-dim' : ''}`}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      title={`${channel.name || `CH ${channel.channelIndex}`} — ${label}${dim ? '' : '. Double-click for the device.'}`}
      role="group"
      aria-label={`${channel.name || `CH ${channel.channelIndex}`}, ${label}`}
    >
      <div className="dt-head">
        <span className="dt-name">{channel.name || `CH ${channel.channelIndex}`}</span>
        <span className="dt-flags">
          {im && <span className="dt-im" title="Intermodulation lands on this channel">IM</span>}
          {(channel.isMuted || channel.isTxMuted) && <VolumeX size={11} />}
          {isIem && <Headphones size={11} />}
        </span>
      </div>

      <div className="dt-meters">
        {/* RF on both antennas for a receiver; a transmitter has one. */}
        <div className="dt-row">
          <span className="dt-lbl">{isIem ? 'TX' : 'A'}</span>
          <Meter value={online ? channel.rfLevelA : 0} kind="rf" variant="bar" className="dt-meter" />
        </div>
        {!isIem && (
          <div className="dt-row">
            <span className="dt-lbl">B</span>
            <Meter value={online ? channel.rfLevelB : 0} kind="rf" variant="bar" className="dt-meter" />
          </div>
        )}
        <div className="dt-row">
          <span className="dt-lbl">{isIem ? 'MON' : 'AF'}</span>
          <Meter value={online ? channel.afLevel : 0} kind="af" variant="bar" className="dt-meter" />
        </div>
      </div>

      <div className="dt-foot">
        <span className={`dt-status dt-status-${tone}`}>{label}</span>
        {channel.batteryPercent != null && (
          <span className={`dt-batt ${channel.batteryPercent <= 20 ? 'is-low' : ''}`}>
            {Math.round(channel.batteryPercent)}%
          </span>
        )}
      </div>
    </div>
  );
}
