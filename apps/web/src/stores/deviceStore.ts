import { create } from 'zustand';
import { Device } from '@rfdeck/shared-types';
import { API_BASE, apiFetch } from '../lib/api';

export type DeviceType = 'input' | 'output';

export interface InventoryDevice {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  ip: string;
  port: number;
  location: string;
  notes: string;
  // Whether a device password is stored. The password itself is never sent to
  // a client — it unlocks the wireless hardware and stays server-side.
  hasPassword?: boolean;
  // Set when the device is reachable but refused the stored password. The
  // device counts as online — it answers — yet no channel data will arrive
  // until this is fixed, so it is shown as its own condition, not as healthy.
  authFailed?: string | null;
  deviceType: DeviceType;
  // Operator-controlled. Inactive = intentionally powered off / not in this show.
  // Inactive devices are untracked server-side and hidden from the dashboard.
  active: boolean;
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
  // Tracks which ip:port strings are currently online, independent of inventory
  // load order.  Lets markDeviceOnline/Offline survive a fetchInventory() call
  // that arrives after the socket replay has already fired.
  _onlineSet: Set<string>;

  fetchInventory: () => Promise<void>;
  // `active` is optional on add — new devices default to active.
  // `password` is write-only: it is sent when creating a device but never
  // returned, so it isn't part of InventoryDevice. Omit it and the server
  // applies the configured default.
  addToInventory: (
    device: Omit<InventoryDevice, 'id' | 'addedAt' | 'online' | 'active' | 'hasPassword'>
      & { active?: boolean; password?: string }
  ) => Promise<void>;
  removeFromInventory: (id: string) => Promise<void>;
  updateInventoryDevice: (id: string, partial: Partial<InventoryDevice>) => Promise<void>;
  setDeviceActive: (id: string, active: boolean) => Promise<void>;
  /** Start/end-of-day switch: every device at once. */
  setAllDevicesActive: (active: boolean) => Promise<void>;
  updateDeviceMetadata: (ip: string, port: number, meta: { deviceName?: string; firmware?: string; serial?: string; mac?: string; model?: string }) => void;

  devices: Device[];
  setDevices: (devices: Device[]) => void;
  updateDevice: (id: string, partial: Partial<Device>) => void;
  markDeviceOnline: (ip: string, port: number, metadata?: Partial<InventoryDevice>) => void;
  markDeviceOffline: (ip: string, port: number) => void;
  /** Reachable but refusing the password (reason), or null when resolved. */
  setDeviceAuth: (ip: string, port: number, reason: string | null) => void;
  /** Rebuild the server-side connection now, using the stored credentials. */
  reconnectDevice: (id: string) => Promise<void>;

  discovered: DiscoveredDevice[];
  setDiscovered: (devices: DiscoveredDevice[]) => void;
  addDiscovered: (device: DiscoveredDevice) => void;
  removeDiscovered: (ip: string) => void;
}

export const useDeviceStore = create<DeviceState>()((set, get) => ({
  inventory: [],
  _onlineSet: new Set<string>(),

  fetchInventory: async () => {
    try {
      const res = await fetch(`${API_BASE}/inventory`);
      const data = await res.json();
      // Apply any online status that arrived via socket before this fetch completed
      const onlineSet = get()._onlineSet;
      set({
        inventory: data.map((d: any) => ({
          ...d,
          online: onlineSet.has(`${d.ip}:${d.port}`) || onlineSet.has(d.ip),
          deviceType: d.deviceType ?? 'input',
          active: d.active ?? true,
        })),
      });
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
      const onlineSet = get()._onlineSet;
      set((state) => ({
        inventory: [
          ...state.inventory,
          {
            ...newDevice,
            online: onlineSet.has(`${newDevice.ip}:${newDevice.port}`),
            active: newDevice.active ?? true,
          },
        ],
      }));
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

  setDeviceActive: async (id, active) => {
    // Optimistic — the toggle should feel instant even though the server has to
    // start/stop a client. A failure reverts it.
    const prev = get().inventory.find((d) => d.id === id)?.active ?? true;
    set((state) => ({
      inventory: state.inventory.map((d) => (d.id === id ? { ...d, active } : d)),
    }));
    try {
      const res = await fetch(`${API_BASE}/inventory/${id}/active`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('Failed to set device active state:', err);
      set((state) => ({
        inventory: state.inventory.map((d) => (d.id === id ? { ...d, active: prev } : d)),
      }));
    }
  },

  setAllDevicesActive: async (active) => {
    // Optimistic like the single toggle; a failure reloads the truth rather
    // than trying to remember which of many rows to revert.
    const before = get().inventory;
    set((state) => ({
      inventory: state.inventory.map((d) => ({ ...d, active })),
    }));
    try {
      await apiFetch('/inventory/active', {
        method: 'PATCH',
        body: JSON.stringify({ active }),
      });
    } catch (err) {
      console.error('Failed to set all devices active state:', err);
      set({ inventory: before });
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
    set((state) => {
      const next = new Set(state._onlineSet);
      next.add(key);
      next.add(ip); // IP-only key so fetchInventory finds it regardless of stored port
      // Match by IP only — the port stored in the DB may differ from the port used
      // in the device:online event (e.g. device re-added via manual entry at port 443
      // but tracked internally at port 53212 for MCP). Physical devices have unique IPs.
      const inInventory = state.inventory.some((d) => d.ip === ip);
      return {
        _onlineSet: next,
        inventory: state.inventory.map((d) =>
          d.ip === ip ? { ...d, online: true, ...(metadata || {}) } : d
        ),
        discovered: inInventory
          ? state.discovered.filter((d) => d.ip !== ip)
          : state.discovered,
      };
    });
  },

  markDeviceOffline: (ip, port) => {
    const key = `${ip}:${port}`;
    set((state) => {
      const next = new Set(state._onlineSet);
      next.delete(key);
      next.delete(ip);
      return {
        _onlineSet: next,
        inventory: state.inventory.map((d) =>
          d.ip === ip ? { ...d, online: false } : d
        ),
      };
    });
  },

  setDeviceAuth: (ip, port, reason) =>
    set((state) => ({
      inventory: state.inventory.map((d) =>
        d.ip === ip && d.port === port ? { ...d, authFailed: reason } : d
      ),
    })),

  reconnectDevice: async (id) => {
    // The server re-tracks the device and clears the refusal itself; the
    // outcome arrives over the socket as device:auth, so nothing to set here.
    try {
      await apiFetch(`/inventory/${id}/reconnect`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to reconnect device:', err);
    }
  },

  updateDeviceMetadata: (ip, port, meta) =>
    set((state) => ({
      inventory: state.inventory.map((d) =>
        d.ip === ip && d.port === port
          ? {
              ...d,
              ...(meta.firmware  ? { firmware: meta.firmware }  : {}),
              ...(meta.serial    ? { serial:   meta.serial }    : {}),
              ...(meta.mac       ? { mac:      meta.mac }       : {}),
              ...(meta.model     ? { model:    meta.model }     : {}),
              ...(meta.deviceName && !d.name.trim() ? { name: meta.deviceName } : {}),
            }
          : d
      ),
    })),

  discovered: [],
  setDiscovered: (devices) => set({ discovered: devices }),
  addDiscovered: (device) =>
    set((state) => {
      if (state.inventory.some((d) => d.ip === device.ip)) return state;
      const existingIdx = state.discovered.findIndex((d) => d.ip === device.ip);
      if (existingIdx >= 0) {
        const updated = [...state.discovered];
        updated[existingIdx] = { ...updated[existingIdx], ...device };
        return { discovered: updated };
      }
      return { discovered: [...state.discovered, device] };
    }),
  removeDiscovered: (ip) =>
    set((state) => ({ discovered: state.discovered.filter((d) => d.ip !== ip) })),
}));

// Initialize inventory from backend on load
useDeviceStore.getState().fetchInventory();
