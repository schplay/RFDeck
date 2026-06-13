import crypto from 'crypto';
import { DiscoveryService, DiscoveredDevice } from './DiscoveryService';
import { SSCClient } from './SSCClient';
import { G3G4Client } from './G3G4Client';
import { EventEmitter } from 'events';
import { Server } from 'socket.io';
import { Device, Channel } from '@rfdeck/shared-types';
import { prisma } from '../../db';

type ClientType = SSCClient | G3G4Client;

export class DeviceManagerService extends EventEmitter {
  private discovery: DiscoveryService;
  private io: Server;
  private clients: Map<string, ClientType> = new Map();
  private channelCache: Map<string, Channel> = new Map();

  constructor(io: Server) {
    super();
    this.io = io;
    this.discovery = new DiscoveryService();

    this.discovery.on('discovered', (device: DiscoveredDevice) => {
      this.handleDiscovered(device);
    });
  }

  async start() {
    // Load inventory from DB on startup and begin tracking
    const inventory = await prisma.inventoryDevice.findMany();
    for (const dev of inventory) {
      this.trackDevice(dev);
    }
    
    this.discovery.start();
  }

  stop() {
    this.discovery.stop();
    for (const client of this.clients.values()) {
      client.stopPolling();
    }
  }

  // Called via REST API when user adds a device
  public trackDevice(device: { ip: string; port: number; name?: string }) {
    const id = `${device.ip}:${device.port}`;
    if (this.clients.has(id)) return;

    // First try SSCv2 (HTTPS)
    const client = new SSCClient(device.ip, device.port);
    this.setupClientListeners(client, device.ip, device.port, id);
    
    client.on('disconnected', () => {
      // If SSCv2 fails, let's try falling back to G3/G4 legacy TCP client
      if (!this.clients.get(`${id}-legacy`)) {
        console.log(`[DeviceManager] SSCv2 failed for ${device.ip}, falling back to G3/G4 legacy protocol`);
        const legacyClient = new G3G4Client(device.ip, device.port);
        this.clients.set(`${id}-legacy`, legacyClient);
        this.setupClientListeners(legacyClient, device.ip, device.port, `${id}-legacy`);
        legacyClient.startPolling();
      }
    });

    this.clients.set(id, client);
    client.startPolling(250);
  }

  public updateTrackedDevice(device: { ip: string; port: number }) {
    this.untrackDevice(device.ip, device.port);
    this.trackDevice(device);
  }

  public untrackDevice(ip: string, port: number) {
    const id = `${ip}:${port}`;
    const client = this.clients.get(id);
    if (client) {
      client.stopPolling();
      this.clients.delete(id);
    }
    const legacy = this.clients.get(`${id}-legacy`);
    if (legacy) {
      legacy.stopPolling();
      this.clients.delete(`${id}-legacy`);
    }
  }

  private setupClientListeners(client: ClientType, ip: string, port: number, id: string) {
    client.on('state', (stateTree: any) => {
      this.normalizeAndEmit(id, stateTree);
    });

    client.on('connected', () => {
      console.log(`[DeviceManager] Connected to ${ip} via ${client instanceof SSCClient ? 'SSCv2' : 'G3/G4'}`);
    });

    client.on('disconnected', (err: any) => {
      console.log(`[DeviceManager] Disconnected from ${ip} - ${err}`);
      this.emit('device:lost', { ip, port });
    });
  }

  private handleDiscovered(device: DiscoveredDevice) {
    // Notify the socket plugin so it can forward to the frontend's mDNS discovery list
    this.emit('device:discovered', device);
    // If it's not in our tracked clients, maybe we auto-track? 
    // Or we leave it to the user to add it via the UI.
  }


  private normalizeAndEmit(deviceId: string, sscState: any) {
    // Iterate over possible receivers in the state (e.g. rx1, rx2)
    const receivers = ['rx1', 'rx2', 'rx3', 'rx4'];

    receivers.forEach((rx, index) => {
      if (sscState[rx]) {
        const rxData = sscState[rx];

        const channelId = `${deviceId}-${rx}`;

        // Convert RF levels (often 0-100 or dBm) to a 0-100 percentage for UI
        const rfA = typeof rxData.rf_quality === 'number' ? rxData.rf_quality : 0;
        const rfB = typeof rxData.rf_quality_b === 'number' ? rxData.rf_quality_b : rfA;

        // Convert AF level to percentage
        const afLevel = typeof rxData.af_level === 'number' ? Math.max(0, 100 + rxData.af_level) : 0;

        const newChannel: Channel = {
          id: channelId,
          deviceId: deviceId,
          channelIndex: index + 1,
          name: rxData.name || `Channel ${index + 1}`,
          frequency: rxData.frequency || 0,
          rfLevelA: rfA,
          rfLevelB: rfB,
          afLevel: afLevel,
          batteryPercent: rxData.battery?.percent,
          isMuted: rxData.mute === true,
          gain: rxData.audio?.gain || 0,
          status: rxData.mute ? 'WARNING' : (rfA < 20 ? 'CRITICAL' : 'ACTIVE')
        };


        // Check if anything changed
        const oldChannel = this.channelCache.get(channelId);
        if (JSON.stringify(oldChannel) !== JSON.stringify(newChannel)) {
          this.channelCache.set(channelId, newChannel);
          this.io.emit('channel:telemetry', newChannel);

          // Alert Engine Logic
          if (oldChannel) {
            // Mute
            if (!oldChannel.isMuted && newChannel.isMuted) {
              this.emitAlert({
                severity: 'WARNING',
                type: 'MUTED',
                message: `Channel muted`,
                channelId,
                channelName: newChannel.name,
                deviceId
              });
            }

            // Battery
            const oldBatt = oldChannel.batteryPercent;
            const newBatt = newChannel.batteryPercent;
            if (oldBatt !== undefined && newBatt !== undefined) {
              if (oldBatt > 20 && newBatt <= 20 && newBatt > 5) {
                this.emitAlert({
                  severity: 'WARNING',
                  type: 'LOW_BATTERY',
                  message: `Battery low (${newBatt}%)`,
                  channelId,
                  channelName: newChannel.name,
                  deviceId
                });
              } else if (oldBatt > 5 && newBatt <= 5) {
                this.emitAlert({
                  severity: 'CRITICAL',
                  type: 'CRITICAL_BATTERY',
                  message: `Battery critical (${newBatt}%)`,
                  channelId,
                  channelName: newChannel.name,
                  deviceId
                });
              }
            }

            // RF Dropout
            if (oldChannel.rfLevelA >= 20 && newChannel.rfLevelA < 20 && !newChannel.isMuted) {
               this.emitAlert({
                 severity: 'CRITICAL',
                 type: 'DROPOUT',
                 message: `RF Dropout detected`,
                 channelId,
                 channelName: newChannel.name,
                 deviceId
               });
            }
          }
        }
      }
    });
  }

  private emitAlert(params: { severity: any, type: any, message: string, detail?: string, channelId?: string, channelName?: string, deviceId?: string, deviceName?: string }) {
    const alert = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      acknowledged: false,
      dismissed: false,
      ...params
    };
    this.io.emit('alert:new', alert);
  }

  // --- External Control APIs ---

  async muteChannel(deviceId: string, rxIndex: number, muted: boolean) {
    const client = this.clients.get(deviceId);
    if (!client) {
      console.warn(`[DeviceManager] Cannot mute channel, device ${deviceId} not connected.`);
      return false;
    }
    return client.setMute(rxIndex, muted);
  }

  async identifyDevice(deviceId: string) {
    const client = this.clients.get(deviceId);
    if (!client) {
      console.warn(`[DeviceManager] Cannot identify, device ${deviceId} not connected.`);
      return false;
    }
    return client.identify();
  }

  async setChannelGain(deviceId: string, rxIndex: number, gain: number) {
    const client = this.clients.get(deviceId);
    if (!client || !(client instanceof SSCClient)) {
      console.warn(`[DeviceManager] Cannot set gain, device ${deviceId} not connected or legacy.`);
      return false;
    }
    return client.setGain(rxIndex, gain);
  }

  async setChannelFrequency(deviceId: string, rxIndex: number, frequencyHz: number) {
    const client = this.clients.get(deviceId);
    if (!client || !(client instanceof SSCClient)) {
      console.warn(`[DeviceManager] Cannot set frequency, device ${deviceId} not connected or legacy.`);
      return false;
    }
    return client.setFrequency(rxIndex, frequencyHz);
  }

  async setDeviceNetwork(deviceId: string, staticIp: string, subnet: string, gateway: string) {
    const client = this.clients.get(deviceId);
    if (!client || !(client instanceof SSCClient)) {
      console.warn(`[DeviceManager] Cannot set network, device ${deviceId} not connected or legacy.`);
      return false;
    }
    return client.setNetwork(staticIp, subnet, gateway);
  }
}




