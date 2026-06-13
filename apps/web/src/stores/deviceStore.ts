import { create } from 'zustand';
import { Device } from '@rfdeck/shared-types';

export interface InventoryDevice {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  ip: string;
  port: number;
  location: string;
  notes: string;
  addedAt: string;
  online: boolean;
  firmware?: string;
  serial?: string;
  mac?: string;
  channelCount?: number;
  activeChannelCount?: number;
}

export interface DiscoveredDevice {
  key: string;
  name: string;
  ip: string;
  port: number;
  manufacturer: string;
  model: string;
}

interface DeviceState {
  inventory: InventoryDevice[];
  fetchInventory: () => Promise<void>;
  addToInventory: (device: Omit<InventoryDevice, 'id' | 'addedAt' | 'online'>) => Promise<void>;
  removeFromInventory: (id: string) => Promise<void>;
  updateInventoryDevice: (id: string, partial: Partial<InventoryDevice>) => Promise<void>;

  devices: Device[];
  setDevices: (devices: Device[]) => void;
  updateDevice: (id: string, partial: Partial<Device>) => void;
  markDeviceOnline: (ip: string, port: number, metadata?: Partial<InventoryDevice>) => void;
  markDeviceOffline: (ip: string, port: number) => void;

  discovered: DiscoveredDevice[];
  setDiscovered: (devices: DiscoveredDevice[]) => void;
  addDiscovered: (device: DiscoveredDevice) => void;
}

const API_BASE = 'http://localhost:3000/api';

export const useDeviceStore = create<DeviceState>()((set, get) => ({
  inventory: [],

  fetchInventory: async () => {
    try {
      const res = await fetch(`${API_BASE}/inventory`);
      const data = await res.json();
      // Ensure online is false initially until socket confirms
      set({ inventory: data.map((d: any) => ({ ...d, online: false })) });
    } catch (err) {
      console.error('Failed to fetch inventory:', err);
    }
  },

  addToInventory: async (deviceData) => {
    try {
      const res = await fetch(`${API_BASE}/inventory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deviceData),
      });
      const newDevice = await res.json();
      set((state) => ({ inventory: [...state.inventory, { ...newDevice, online: false }] }));
    } catch (err) {
      console.error('Failed to add to inventory:', err);
    }
  },

  removeFromInventory: async (id) => {
    try {
      await fetch(`${API_BASE}/inventory/${id}`, { method: 'DELETE' });
      set((state) => ({ inventory: state.inventory.filter((d) => d.id !== id) }));
    } catch (err) {
      console.error('Failed to remove from inventory:', err);
    }
  },

  updateInventoryDevice: async (id, partial) => {
    try {
      const res = await fetch(`${API_BASE}/inventory/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      const updated = await res.json();
      set((state) => ({
        inventory: state.inventory.map((d) => (d.id === id ? { ...d, ...updated } : d)),
      }));
    } catch (err) {
      console.error('Failed to update inventory:', err);
    }
  },

  devices: [],
  setDevices: (devices) => set({ devices }),
  updateDevice: (id, partial) =>
    set((state) => ({
      devices: state.devices.map((d) => (d.id === id ? { ...d, ...partial } : d)),
    })),

  markDeviceOnline: (ip, port, metadata) => {
    const key = `${ip}:${port}`;
    set((state) => ({
      inventory: state.inventory.map((d) =>
        d.ip === ip && d.port === port
          ? { ...d, online: true, ...(metadata || {}) }
          : d
      ),
      discovered: state.discovered.filter((d) => d.key !== key),
    }));
  },

  markDeviceOffline: (ip, port) =>
    set((state) => ({
      inventory: state.inventory.map((d) =>
        d.ip === ip && d.port === port ? { ...d, online: false } : d
      ),
    })),

  discovered: [],
  setDiscovered: (devices) => set({ discovered: devices }),
  addDiscovered: (device) =>
    set((state) => {
      const alreadyKnown = state.inventory.some(
        (d) => d.ip === device.ip && d.port === device.port
      );
      const alreadyDiscovered = state.discovered.some((d) => d.key === device.key);
      if (alreadyKnown || alreadyDiscovered) return state;
      return { discovered: [...state.discovered, device] };
    }),
}));

// Initialize inventory from backend on load
useDeviceStore.getState().fetchInventory();


