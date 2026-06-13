import React from 'react';
import { Card } from '../ui/Card';
import { Channel } from '@rfdeck/shared-types';
import { Mic, AlertTriangle, AlertCircle, VolumeX, Headphones } from 'lucide-react';
import { useSocket } from '../../hooks/useSocket';
import { useFrequencyHistoryStore } from '../../stores/frequencyHistoryStore';
import './ChannelStrip.css';

interface ChannelStripProps {
  channel: Channel;
}

export const ChannelStrip: React.FC<ChannelStripProps> = ({ channel }) => {
  const { socket, isConnected } = useSocket();
  const statusBorder = channel.status === 'ACTIVE' ? 'success' :
                       channel.status === 'WARNING' ? 'warning' : 'error';

  // Helper to render segmented meter
  const renderMeter = (level: number, type: 'rf' | 'af') => {
    const segments = 10;
    const activeCount = Math.floor((level / 100) * segments);
    
    return (
      <div className="meter-stack">
        {Array.from({ length: segments }).map((_, i) => {
          // index from bottom up: 0 is bottom, 9 is top
          const index = segments - 1 - i;
          const isActive = index < activeCount;
          
          let colorClass = 'meter-segment';
          if (isActive) {
            if (type === 'rf') {
               if (index >= 9) colorClass += ' active-red';
               else if (index >= 7) colorClass += ' active-orange';
               else colorClass += ' active-green';
            } else { // af
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
    if (channel.status === 'CRITICAL') return <AlertCircle size={18} className="text-error" />;
    if (channel.status === 'WARNING') return <AlertTriangle size={18} className="text-warning" />;
    return <Mic size={18} className="text-primary" />;
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
          {renderMeter(channel.rfLevelA, 'rf')}
          {renderMeter(channel.rfLevelB, 'rf')}
          <div className="meter-spacer" />
          {renderMeter(channel.afLevel, 'af')}
        </div>
        
        <div className="cs-data">
          <div className="cs-freq">
            <input 
              type="number" 
              className="freq-input"
              defaultValue={(channel.frequency / 1000).toFixed(3)} 
              onBlur={(e) => {
                const val = parseFloat(e.target.value);
                const newHz = Math.round(val * 1000);
                if (!isNaN(val) && socket && isConnected && newHz !== channel.frequency) {
                  // Log the manual change before emitting
                  if (channel.frequency > 0) {
                    useFrequencyHistoryStore.getState().addEvent({
                      channelId: channel.id,
                      channelName: channel.name || `CH ${channel.channelIndex}`,
                      deviceId: channel.deviceId,
                      previousFrequencyHz: channel.frequency,
                      newFrequencyHz: newHz,
                      timestamp: new Date().toISOString(),
                      source: 'MANUAL',
                    });
                  }
                  socket.emit('channel:frequency', {
                    deviceId: channel.deviceId,
                    rxIndex: channel.channelIndex,
                    frequencyHz: newHz,
                  });
                }
              }}
            /> 
            <span>MHz</span>
          </div>
          <div className={`cs-batt ${channel.batteryPercent && channel.batteryPercent <= 20 ? 'batt-low' : ''}`}>
            {channel.batteryPercent ?? '--'}%
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
        <button className="cs-btn btn-primary">
          <Headphones size={14} /> Listen
        </button>
      </div>
    </Card>
  );
};

