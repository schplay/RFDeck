import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useChannelStore } from '../stores/channelStore';
import { useDeviceStore, DiscoveredDevice } from '../stores/deviceStore';
import { useAlertStore } from '../stores/alertStore';
import { useFrequencyHistoryStore } from '../stores/frequencyHistoryStore';
import { Channel, Alert } from '@rfdeck/shared-types';

const SOCKET_URL = 'http://localhost:3000';

export const useSocket = () => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const newSocket = io(SOCKET_URL);
    setSocket(newSocket);

    newSocket.on('connect', () => {
      setIsConnected(true);
      console.log('[RFDeck] Connected to server');
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
      console.log('[RFDeck] Disconnected from server');
    });

    // Live channel telemetry — update or add channel in store
    newSocket.on('channel:telemetry', (channelData: Channel) => {
      useChannelStore.setState((state) => {
        const existing = state.channels.find((c) => c.id === channelData.id);

        // Frequency change detection — only log when frequency is non-zero and actually different
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

        if (existing) {
          return {
            channels: state.channels.map((c) =>
              c.id === channelData.id ? { ...c, ...channelData } : c
            ),
          };
        }
        return { channels: [...state.channels, channelData] };
      });
    });

    // Alerts
    newSocket.on('alert:new', (alert: Alert) => {
      useAlertStore.getState().addAlert(alert);
    });

    // mDNS discovered device — surface in the Add Device dialog
    newSocket.on('device:discovered', (device: DiscoveredDevice) => {
      useDeviceStore.getState().addDiscovered(device);
      // Also mark as online if already in inventory
      useDeviceStore.getState().markDeviceOnline(device.ip, device.port, {
        model: device.model,
        manufacturer: device.manufacturer,
      });
    });

    // Device lost from network
    newSocket.on('device:lost', (device: { ip: string; port: number }) => {
      useDeviceStore.getState().markDeviceOffline(device.ip, device.port);
    });

    return () => {
      newSocket.close();
    };
  }, []);

  return { socket, isConnected };
};
