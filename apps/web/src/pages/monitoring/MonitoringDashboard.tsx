import React, { useState, useMemo } from 'react';
import { ChannelStrip } from '../../components/channel/ChannelStrip';
import { useDeviceStore } from '../../stores/deviceStore';
import { useActiveChannels } from '../../hooks/useActiveChannels';
import { DeviceDrawer } from '../inventory/components/DeviceDrawer';
import { useLayoutStore, sortChannels, useDragReorder, useFlipAnimation } from '../../stores/layoutStore';
import { LayoutGrid, List, Search, ArrowUpDown } from 'lucide-react';
import './MonitoringDashboard.css';

export default function MonitoringDashboard() {
  const channels = useActiveChannels();
  const { inventory } = useDeviceStore();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const orderMode = useLayoutStore(s => s.orderMode);
  const customOrder = useLayoutStore(s => s.customOrder);
  const setOrderMode = useLayoutStore(s => s.setOrderMode);
  const [sortBy, setSortBy] = useState<'name' | 'frequency' | 'battery' | 'custom'>(
    orderMode === 'custom' ? 'custom' : 'name'
  );

  const handleSortChange = (value: string) => {
    setSortBy(value as any);
    // Keep the shared layout store in sync so the Backstage view follows.
    setOrderMode(value === 'custom' ? 'custom' : 'alpha');
  };

  // O(1) device lookup by IP — recomputed only when inventory changes
  const deviceByIp = useMemo(() => {
    const map = new Map<string, typeof inventory[number]>();
    for (const d of inventory) map.set(d.ip, d);
    return map;
  }, [inventory]);

  const filteredChannels = useMemo(() => {
    const q = searchQuery.toLowerCase();
    const filtered = channels.filter(ch =>
      ch.name.toLowerCase().includes(q) ||
      ch.deviceId.toLowerCase().includes(q)
    );
    if (sortBy === 'custom') return sortChannels(filtered, 'custom', customOrder);
    return filtered.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'frequency') return a.frequency - b.frequency;
      if (sortBy === 'battery') return (a.batteryPercent ?? 100) - (b.batteryPercent ?? 100);
      return 0;
    });
  }, [channels, searchQuery, sortBy, customOrder]);

  const { handlers: dragHandlers } = useDragReorder(filteredChannels);
  const setFlipRef = useFlipAnimation(filteredChannels.map(ch => ch.id).join('|'));

  // Double-clicking a channel opens the details drawer for its parent device.
  // Held by ID so the drawer reflects live store updates rather than a snapshot.
  const [drawerDeviceId, setDrawerDeviceId] = useState<string | null>(null);
  const drawerDevice = useMemo(
    () => inventory.find(d => d.id === drawerDeviceId) ?? null,
    [inventory, drawerDeviceId]
  );
  const openDeviceFor = (ch: { deviceId: string }) => {
    const dev = deviceByIp.get(ch.deviceId.split(':')[0]);
    if (dev) setDrawerDeviceId(dev.id);
  };

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
              <select value={sortBy} onChange={(e) => handleSortChange(e.target.value)}>
                <option value="name">Sort by Name</option>
                <option value="frequency">Sort by Frequency</option>
                <option value="battery">Sort by Battery</option>
                <option value="custom">Custom Order</option>
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
          filteredChannels.map(ch => {
            const dev = deviceByIp.get(ch.deviceId.split(':')[0]);
            return (
              <div
                key={ch.id}
                ref={setFlipRef(ch.id)}
                onDoubleClick={() => openDeviceFor(ch)}
                title="Double-click for device details"
                {...dragHandlers(ch)}
              >
                <ChannelStrip
                  channel={ch}
                  deviceType={dev?.deviceType}
                  deviceOnline={dev?.online ?? true}
                />
              </div>
            );
          })
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
            {filteredChannels.map(ch => {
              const dev = deviceByIp.get(ch.deviceId.split(':')[0]);
              const online = dev?.online ?? true;
              return (
                <div
                  key={ch.id}
                  className={`list-row ${!online ? 'list-row-offline' : ''}`}
                  onDoubleClick={() => openDeviceFor(ch)}
                  title="Double-click for device details"
                >
                  <div className="col-status">
                    <div className={`status-indicator ${!online ? 'offline' : ch.status.toLowerCase()}`} />
                  </div>
                  <div className="col-name">
                    <strong>{ch.name || `CH ${ch.channelIndex}`}</strong>
                    <span>{ch.deviceId.split(':')[0]}{!online ? ' · Offline' : ''}</span>
                  </div>
                  <div className="col-freq">{ch.frequency > 0 ? (ch.frequency / 1000).toFixed(3) : '—'} MHz</div>
                  <div className="col-meters">
                    <div className="mini-meter" style={{ '--fill': `${online ? ch.rfLevelA : 0}%` } as any} />
                    <div className="mini-meter" style={{ '--fill': `${online ? ch.rfLevelB : 0}%` } as any} />
                  </div>
                  <div className={`col-batt ${ch.batteryPercent && ch.batteryPercent <= 20 ? 'low' : ''}`}>
                    {ch.batteryPercent != null ? Math.round(ch.batteryPercent) : '--'}%
                  </div>
                  <div className="col-actions">
                    <button className="btn-secondary-sm">Mute</button>
                    <button className="btn-primary-sm">Listen</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Device details — opened by double-clicking a channel */}
      <DeviceDrawer device={drawerDevice} onClose={() => setDrawerDeviceId(null)} />
    </div>
  );
}

