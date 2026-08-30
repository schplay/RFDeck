import React, { useState, useMemo } from 'react';
import { Plus, Search, Grid, List, Wifi, WifiOff, ChevronDown, Power, PowerOff, ArrowUpDown } from 'lucide-react';
import { useDeviceStore, InventoryDevice } from '../../stores/deviceStore';
import { HardwareCard } from './components/HardwareCard';
import { DeviceDrawer } from './components/DeviceDrawer';
import { AddDeviceDialog } from './components/AddDeviceDialog';
import './InventoryManager.css';

const MANUFACTURERS = ['All Manufacturers', 'Sennheiser', 'Shure', 'Wisycom', 'Lectrosonics', 'Sony'];
const LOCATIONS = ['All Locations', 'Stage Left', 'Stage Right', 'FOH', 'Backstage', 'Monitors'];

type SortKey = 'name' | 'status' | 'ip' | 'location' | 'model';

// Sort IPs numerically by octet so 10.2.1.9 comes before 10.2.1.10.
function compareIp(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const byName = (a: InventoryDevice, b: InventoryDevice) => a.name.localeCompare(b.name);

const SORTERS: Record<SortKey, (a: InventoryDevice, b: InventoryDevice) => number> = {
  name: byName,
  // Online first, then offline, then inactive — most-actionable at the top.
  status: (a, b) => {
    const rank = (d: InventoryDevice) => (d.active === false ? 2 : d.online ? 0 : 1);
    return rank(a) - rank(b) || byName(a, b);
  },
  ip: (a, b) => compareIp(a.ip, b.ip) || byName(a, b),
  location: (a, b) => (a.location || '~').localeCompare(b.location || '~') || byName(a, b),
  model: (a, b) =>
    a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model) || byName(a, b),
};

export default function InventoryManager() {
  const { inventory, setDeviceActive, setAllDevicesActive } = useDeviceStore();

  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState('');
  const [filterMfr, setFilterMfr] = useState('All Manufacturers');
  const [filterLocation, setFilterLocation] = useState('All Locations');
  const [sortBy, setSortBy] = useState<SortKey>('name');
  // Track the selected device by ID, not by object — a captured object is a
  // snapshot and would go stale as soon as the store updates (e.g. toggling
  // active), leaving the drawer showing the old state.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const selectedDevice = useMemo(
    () => inventory.find((d) => d.id === selectedId) ?? null,
    [inventory, selectedId]
  );

  const filtered = useMemo(() => {
    const result = inventory.filter((d) => {
      const matchSearch =
        search === '' ||
        d.name.toLowerCase().includes(search.toLowerCase()) ||
        d.model.toLowerCase().includes(search.toLowerCase()) ||
        d.ip.includes(search);
      const matchMfr = filterMfr === 'All Manufacturers' || d.manufacturer === filterMfr;
      const matchLoc = filterLocation === 'All Locations' || d.location === filterLocation;
      return matchSearch && matchMfr && matchLoc;
    });
    return result.sort(SORTERS[sortBy]);
  }, [inventory, search, filterMfr, filterLocation, sortBy]);

  // Inactive devices are excluded from the online/offline tally — they're
  // intentionally powered off, so counting them as "offline" is misleading.
  const activeDevices = inventory.filter((d) => d.active !== false);
  const onlineCount = activeDevices.filter((d) => d.online).length;
  const offlineCount = activeDevices.length - onlineCount;
  const inactiveCount = inventory.length - activeDevices.length;

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
            {inactiveCount > 0 && (
              <span className="stat-badge stat-inactive">
                <PowerOff size={12} />
                {inactiveCount} Inactive
              </span>
            )}
            <span className="stat-badge stat-total">{inventory.length} Total</span>
          </div>
        </div>
        <div className="inventory-header-actions">
          {/* Start/end-of-day switch. One press instead of a toggle per row:
              disabling before powering the rack down is what keeps the log
              clean, and it only happens if it is not a chore. */}
          {inventory.length > 0 && (
            activeDevices.length > 0 ? (
              <button
                className="btn-secondary"
                onClick={() => {
                  if (window.confirm(
                    `Disable all ${activeDevices.length} active device(s)?\n\n` +
                    'They stop being monitored — no cards, no alerts — until re-enabled. ' +
                    'Do this before powering the rack down.'
                  )) setAllDevicesActive(false);
                }}
                title="End of day: stop monitoring every device before powering the rack down"
              >
                <PowerOff size={16} />
                Disable All
              </button>
            ) : (
              <button
                className="btn-secondary"
                onClick={() => setAllDevicesActive(true)}
                title="Start of day: resume monitoring every device"
              >
                <Power size={16} />
                Enable All
              </button>
            )
          )}
          <button className="btn-primary" onClick={() => setAddDialogOpen(true)}>
            <Plus size={16} />
            Add Device
          </button>
        </div>
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

          <div className="select-wrapper">
            <ArrowUpDown size={13} className="select-lead-icon" />
            <select
              className="filter-select has-lead-icon"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              title="Sort devices"
            >
              <option value="name">Sort by Name</option>
              <option value="status">Sort by Status</option>
              <option value="ip">Sort by IP Address</option>
              <option value="location">Sort by Location</option>
              <option value="model">Sort by Model</option>
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
              onClick={() => setSelectedId(device.id)}
              onToggleActive={() => setDeviceActive(device.id, device.active === false)}
            />
          ))}
        </div>
      )}

      {/* Device Detail Drawer */}
      <DeviceDrawer
        device={selectedDevice}
        onClose={() => setSelectedId(null)}
      />

      {/* Add Device Dialog */}
      <AddDeviceDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
      />
    </div>
  );
}
