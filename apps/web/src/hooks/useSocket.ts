import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useChannelStore, type HeartbeatPayload } from '../stores/channelStore';
import { useDeviceStore, DiscoveredDevice } from '../stores/deviceStore';
import { useAlertStore } from '../stores/alertStore';
import { useFrequencyHistoryStore } from '../stores/frequencyHistoryStore';
import { useRfEventStore, RfEvent } from '../stores/rfEventStore';
import { useShowStore } from '../stores/showStore';
import { useBatteryStore, BatteryEstimate } from '../stores/batteryStore';
import { getToken, serverOrigin } from '../lib/api';
import { Channel, Alert, Show, Performer } from '@rfdeck/shared-types';
import { usePerformerStore } from '../stores/performerStore';
import { useDetectionStore, Detection } from '../stores/detectionStore';

// Same origin resolution as the REST client — a hardcoded localhost here would
// leave every remote client permanently disconnected. See lib/api.ts.
const SOCKET_URL = serverOrigin();

// Module-level singleton — one socket connection for the entire app lifetime.
// Multiple components calling useSocket() share this connection; no duplicate
// connections are created when components mount/unmount.
let _socket: Socket | null = null;

function getSocket(): Socket {
  if (_socket) return _socket;

  // Pass the PIN token through the handshake — the socket is gated alongside
  // REST, since control commands travel over it.
  // Bounded waits: the defaults let a reconnect attempt sit for 20s and back
  // off toward 5s between tries, which is most of the "blank for half a
  // minute" a phone sees after waking. On a LAN, either the server answers
  // in a couple of seconds or it is down.
  _socket = io(SOCKET_URL, {
    auth: { token: getToken() },
    timeout: 5_000,
    reconnectionDelayMax: 2_000,
  });

  // A tab coming back from the background should not wait out the reconnect
  // backoff that accumulated while its timers were frozen — ask immediately.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _socket && !_socket.connected) {
      _socket.connect();
    }
  });

  _socket.on('connect', () => {
    console.log('[RFDeck] Connected to server');
  });

  _socket.on('disconnect', () => {
    console.log('[RFDeck] Disconnected from server');
  });

  // Live channel telemetry — update channel store and log events
  _socket.on('channel:telemetry', (channelData: Channel) => {
    // Receiving telemetry is definitive proof the device is online on the server.
    // If the inventory shows it as offline (stale state from a missed device:online or
    // a spurious device:lost), correct it here so the channel strip shows live.
    const telemetryIp = channelData.deviceId.split(':')[0];
    const deviceStore = useDeviceStore.getState();
    const tracked = deviceStore.inventory.find(d => d.ip === telemetryIp);
    if (tracked && !tracked.online) {
      console.log(`[RFDeck] Recovering ${telemetryIp}: telemetry arrived but device was marked offline — forcing online`);
      deviceStore.markDeviceOnline(telemetryIp, tracked.port);
    }

    useChannelStore.setState((state) => {
      const existing = state.channels.find((c) => c.id === channelData.id);

      // Frequency change log — both values non-zero and actually different
      if (
        existing &&
        channelData.frequency > 0 &&
        existing.frequency > 0 &&
        existing.frequency !== channelData.frequency
      ) {
        useFrequencyHistoryStore.getState().addEvent({
          channelId: channelData.id,
          channelName: channelData.name || `CH ${channelData.channelIndex}`,
          deviceId: channelData.deviceId,
          previousFrequencyHz: existing.frequency,
          newFrequencyHz: channelData.frequency,
          timestamp: new Date().toISOString(),
          source: 'TELEMETRY',
        });
      }

      // RF dropout/recovery is detected server-side and arrives via `rf:event`
      // so every client sees an identical log — nothing to derive here.

      // Stamp arrival so views can distinguish live readings from frozen ones.
      const lastUpdate = { ...state.lastUpdate, [channelData.id]: Date.now() };

      if (existing) {
        return {
          channels: state.channels.map((c) =>
            c.id === channelData.id ? { ...c, ...channelData } : c
          ),
          lastUpdate,
        };
      }
      return { channels: [...state.channels, channelData], lastUpdate };
    });
  });

  // Alerts — server-owned so acknowledgement is shared across clients.
  _socket.on('alert:new', (alert: Alert) => {
    useAlertStore.getState().addAlert(alert);
  });

  _socket.on('alert:updated', (alert: Alert) => {
    useAlertStore.getState().applyServerAlert(alert);
  });

  _socket.on('alerts:cleared', () => {
    useAlertStore.getState().applyServerClear();
  });

  // Battery runtime projection, computed server-side from its sampling history.
  _socket.on('battery:estimate', (est: BatteryEstimate) => {
    useBatteryStore.getState().applyEstimate(est);
  });

  // RF dropout / recovery, detected server-side and replayed on connect.
  _socket.on('rf:event', (event: RfEvent) => {
    useRfEventStore.getState().addEvent(event);
  });

  _socket.on('rf:events-cleared', () => {
    useRfEventStore.getState().clearAll();
  });

  // ── Show state (server-authoritative, pushed to every client) ──
  // A mic-check tick made backstage must appear at FOH without a reload.
  _socket.on('show:updated', (show: Show) => {
    useShowStore.getState().applyServerShow(show);
  });

  _socket.on('show:deleted', ({ id }: { id: string }) => {
    useShowStore.getState().applyServerDelete(id);
  });

  // Discovered device — surface in the Add Device dialog only.
  _socket.on('device:discovered', (device: DiscoveredDevice) => {
    useDeviceStore.getState().addDiscovered(device);
  });

  // Discovered entry retracted — it was identified as a secondary interface
  // (e.g. the Dante NIC of an EW-DX that's already tracked in inventory).
  _socket.on('device:undiscovered', ({ ip }: { ip: string; port: number }) => {
    useDeviceStore.getState().removeDiscovered(ip);
  });

  // Device (from inventory) successfully polled/connected
  _socket.on('device:online', (device: { ip: string; port: number }) => {
    useDeviceStore.getState().markDeviceOnline(device.ip, device.port);
  });

  // Device lost from network — mark offline but keep channel data so the
  // "Device Offline" overlay remains visible on the dashboard.
  _socket.on('device:lost', (device: { ip: string; port: number }) => {
    useDeviceStore.getState().markDeviceOffline(device.ip, device.port);
  });

  // Which devices the server is actually in contact with. Staleness keys on
  // this rather than on telemetry arrival, because telemetry is sent only on
  // change and a quiet channel is not a broken one.
  _socket.on('device:heartbeat', (payload: HeartbeatPayload) => {
    useChannelStore.getState().applyHeartbeat(payload);
  });

  // Reachable but refusing the stored password. Distinct from offline: the
  // device answers, it just will not hand over channel data.
  _socket.on('device:auth', (data: { ip: string; port: number; failed: boolean; reason: string | null }) => {
    useDeviceStore.getState().setDeviceAuth(data.ip, data.port, data.failed ? (data.reason ?? 'Password refused') : null);
  });

  // Detections — an incident with audio attached. The clip arrives a moment
  // after the detection itself, as a detection:updated once the post-roll is
  // written, so a card appears immediately and gains its player shortly after.
  _socket.on('detection:new', (d: Detection) => {
    useDetectionStore.getState().applyNew(d);
  });
  _socket.on('detection:updated', (d: Detection) => {
    useDetectionStore.getState().applyUpdated(d);
  });
  _socket.on('detection:deleted', ({ id }: { id: string }) => {
    useDetectionStore.getState().applyDeleted(id);
  });
  _socket.on('detection:pruned', ({ ids }: { ids: string[] }) => {
    useDetectionStore.getState().applyPruned(ids);
  });

  // Performer roster — the whole list on every change, so clients never drift.
  _socket.on('performers:updated', (list: Performer[]) => {
    usePerformerStore.getState().applyServerList(list);
  });

  // SSCv2 device metadata (firmware, serial, mac)
  _socket.on('device:metadata', (data: { ip: string; port: number; deviceName?: string; firmware?: string; serial?: string; mac?: string; model?: string }) => {
    useDeviceStore.getState().updateDeviceMetadata(data.ip, data.port, data);
  });

  // Device changed IP (DHCP re-assignment after power cycle).
  // Clear stale channels for the old IP and refresh inventory so the
  // dashboard and device list reflect the new address immediately.
  _socket.on('device:ip-changed', (data: { id: string; oldIp: string; newIp: string; port: number; name: string }) => {
    console.log(`[RFDeck] Device "${data.name}" moved: ${data.oldIp} → ${data.newIp}`);
    // Drops the freshness stamps too, so the old IP's channels can't linger as
    // permanently-stale ghosts.
    useChannelStore.getState().removeChannelsForDevice(data.oldIp);
    useDeviceStore.getState().fetchInventory();
  });

  // Server removed a duplicate inventory entry created by re-discovery
  _socket.on('device:removed', (data: { id: string }) => {
    useDeviceStore.setState((state) => ({
      inventory: state.inventory.filter((d) => d.id !== data.id),
    }));
  });

  // A device was set active/inactive (possibly from another window). Sync the
  // flag locally; channel strips are removed via the device:untracked event the
  // server emits when it stops tracking.
  _socket.on('device:active-changed', ({ id, active }: { id: string; ip: string; port: number; active: boolean }) => {
    useDeviceStore.setState((state) => ({
      inventory: state.inventory.map((d) => (d.id === id ? { ...d, active } : d)),
    }));
  });

  // Device was explicitly removed from inventory — drop its channel strips immediately
  _socket.on('device:untracked', ({ ip }: { ip: string }) => {
    useChannelStore.getState().removeChannelsForDevice(ip);
  });

  return _socket;
}

export const useSocket = () => {
  const socket = getSocket();
  const [isConnected, setIsConnected] = useState(socket.connected);

  useEffect(() => {
    const onConnect    = () => setIsConnected(true);
    const onDisconnect = () => setIsConnected(false);

    socket.on('connect',    onConnect);
    socket.on('disconnect', onDisconnect);

    // Sync state in case connection changed before this effect ran
    setIsConnected(socket.connected);

    return () => {
      socket.off('connect',    onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  return { socket, isConnected };
};
