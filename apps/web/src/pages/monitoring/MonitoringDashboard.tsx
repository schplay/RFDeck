import React, { useState } from 'react';
import { ChannelStrip } from '../../components/channel/ChannelStrip';
import { useChannelStore } from '../../stores/channelStore';
import { LayoutGrid, List, Search, ArrowUpDown } from 'lucide-react';
import './MonitoringDashboard.css';

export default function MonitoringDashboard() {
  const { channels } = useChannelStore();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'frequency' | 'battery'>('name');

  const filteredChannels = channels.filter(ch => 
    ch.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    ch.deviceId.toLowerCase().includes(searchQuery.toLowerCase())
  ).sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'frequency') return a.frequency - b.frequency;
    if (sortBy === 'battery') return (a.batteryPercent ?? 100) - (b.batteryPercent ?? 100);
    return 0;
  });

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div className="header-left">
          <h1>Monitoring Dashboard</h1>
          <span className="channel-count">{filteredChannels.length} Channels</span>
        </div>
        
        <div className="dashboard-toolbar">
          <div className="search-bar">
            <Search size={14} className="search-icon" />
            <input 
              type="text" 
              placeholder="Filter channels..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="toolbar-group">
            <div className="sort-select">
              <ArrowUpDown size={14} />
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}>
                <option value="name">Sort by Name</option>
                <option value="frequency">Sort by Frequency</option>
                <option value="battery">Sort by Battery</option>
              </select>
            </div>

            <div className="view-toggle">
              <button 
                className={viewMode === 'grid' ? 'active' : ''} 
                onClick={() => setViewMode('grid')}
                title="Grid View"
              >
                <LayoutGrid size={16} />
              </button>
              <button 
                className={viewMode === 'list' ? 'active' : ''} 
                onClick={() => setViewMode('list')}
                title="List View"
              >
                <List size={16} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className={`dashboard-content ${viewMode}`}>
        {filteredChannels.length === 0 ? (
          <div className="empty-state">
            <p>No channels match your filters, or no devices connected.</p>
          </div>
        ) : viewMode === 'grid' ? (
          filteredChannels.map(ch => (
            <ChannelStrip key={ch.id} channel={ch} />
          ))
        ) : (
          <div className="channel-list">
            <div className="list-header">
              <div className="col-status">Status</div>
              <div className="col-name">Name</div>
              <div className="col-freq">Frequency</div>
              <div className="col-meters">RF Levels</div>
              <div className="col-batt">Battery</div>
              <div className="col-actions">Actions</div>
            </div>
            {filteredChannels.map(ch => (
              <div key={ch.id} className="list-row">
                <div className="col-status">
                  <div className={`status-indicator ${ch.status.toLowerCase()}`} />
                </div>
                <div className="col-name">
                  <strong>{ch.name || `CH ${ch.channelIndex}`}</strong>
                  <span>{ch.deviceId.split(':')[0]}</span>
                </div>
                <div className="col-freq">{(ch.frequency / 1000).toFixed(3)} MHz</div>
                <div className="col-meters">
                  <div className="mini-meter" style={{ '--fill': `${ch.rfLevelA}%` } as any} />
                  <div className="mini-meter" style={{ '--fill': `${ch.rfLevelB}%` } as any} />
                </div>
                <div className={`col-batt ${ch.batteryPercent && ch.batteryPercent <= 20 ? 'low' : ''}`}>
                  {ch.batteryPercent ?? '--'}%
                </div>
                <div className="col-actions">
                  <button className="btn-secondary-sm">Mute</button>
                  <button className="btn-primary-sm">Listen</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

