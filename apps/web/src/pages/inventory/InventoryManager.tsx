import React, { useState, useMemo } from 'react';
import { Plus, Search, Grid, List, Wifi, WifiOff, ChevronDown } from 'lucide-react';
import { useDeviceStore, InventoryDevice } from '../../stores/deviceStore';
import { HardwareCard } from './components/HardwareCard';
import { DeviceDrawer } from './components/DeviceDrawer';
import { AddDeviceDialog } from './components/AddDeviceDialog';
import './InventoryManager.css';

const MANUFACTURERS = ['All Manufacturers', 'Sennheiser', 'Shure', 'Wisycom', 'Lectrosonics', 'Sony'];
const LOCATIONS = ['All Locations', 'Stage Left', 'Stage Right', 'FOH', 'Backstage', 'Monitors'];

export default function InventoryManager() {
  const { inventory } = useDeviceStore();

  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [filterMfr, setFilterMfr] = useState('All Manufacturers');
  const [filterLocation, setFilterLocation] = useState('All Locations');
  const [selectedDevice, setSelectedDevice] = useState<InventoryDevice | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const filtered = useMemo(() => {
    return inventory.filter((d) => {
      const matchSearch =
        search === '' ||
        d.name.toLowerCase().includes(search.toLowerCase()) ||
        d.model.toLowerCase().includes(search.toLowerCase()) ||
        d.ip.includes(search);
      const matchMfr = filterMfr === 'All Manufacturers' || d.manufacturer === filterMfr;
      const matchLoc = filterLocation === 'All Locations' || d.location === filterLocation;
      return matchSearch && matchMfr && matchLoc;
    });
  }, [inventory, search, filterMfr, filterLocation]);

  const onlineCount = inventory.filter((d) => d.online).length;
  const offlineCount = inventory.length - onlineCount;

  return (
    <div className="inventory-page">
      {/* Page Header */}
      <div className="inventory-header">
        <div className="inventory-header-left">
          <h1 className="page-title">Hardware Inventory</h1>
          <div className="inventory-stats">
            <span className="stat-badge stat-online">
              <Wifi size={12} />
              {onlineCount} Online
            </span>
            <span className="stat-badge stat-offline">
              <WifiOff size={12} />
              {offlineCount} Offline
            </span>
            <span className="stat-badge stat-total">{inventory.length} Total</span>
          </div>
        </div>
        <button className="btn-primary" onClick={() => setAddDialogOpen(true)}>
          <Plus size={16} />
          Add Device
        </button>
      </div>

      {/* Filters Toolbar */}
      <div className="filters-toolbar">
        <div className="search-wrapper">
          <Search size={15} className="search-icon" />
          <input
            className="search-input"
            placeholder="Search devices, IPs, models..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="filter-group">
          <div className="select-wrapper">
            <select
              className="filter-select"
              value={filterMfr}
              onChange={(e) => setFilterMfr(e.target.value)}
            >
              {MANUFACTURERS.map((m) => <option key={m}>{m}</option>)}
            </select>
            <ChevronDown size={14} className="select-chevron" />
          </div>

          <div className="select-wrapper">
            <select
              className="filter-select"
              value={filterLocation}
              onChange={(e) => setFilterLocation(e.target.value)}
            >
              {LOCATIONS.map((l) => <option key={l}>{l}</option>)}
            </select>
            <ChevronDown size={14} className="select-chevron" />
          </div>
        </div>

        <div className="view-toggle">
          <button
            className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Grid View"
          >
            <Grid size={16} />
          </button>
          <button
            className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
            title="List View"
          >
            <List size={16} />
          </button>
        </div>
      </div>

      {/* Content */}
      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📡</div>
          <h2 className="empty-title">
            {inventory.length === 0 ? 'No devices in inventory' : 'No devices match your filters'}
          </h2>
          <p className="empty-desc">
            {inventory.length === 0
              ? 'Add your first device to get started. You can discover devices on your network or add them manually by IP.'
              : 'Try adjusting your search or filter criteria.'}
          </p>
          {inventory.length === 0 && (
            <button className="btn-primary" onClick={() => setAddDialogOpen(true)}>
              <Plus size={16} />
              Add Your First Device
            </button>
          )}
        </div>
      ) : (
        <div className={viewMode === 'grid' ? 'hardware-grid' : 'hardware-list'}>
          {filtered.map((device) => (
            <HardwareCard
              key={device.id}
              device={device}
              viewMode={viewMode}
              onClick={() => setSelectedDevice(device)}
            />
          ))}
        </div>
      )}

      {/* Device Detail Drawer */}
      <DeviceDrawer
        device={selectedDevice}
        onClose={() => setSelectedDevice(null)}
      />

      {/* Add Device Dialog */}
      <AddDeviceDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
      />
    </div>
  );
}
