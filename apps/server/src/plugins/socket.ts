import fp from 'fastify-plugin';
import { Server } from 'socket.io';
import { DeviceManagerService } from '../hardware/sennheiser/DeviceManagerService';
import { DiscoveredDevice } from '../hardware/sennheiser/DiscoveryService';
import { mcpBus } from '../hardware/sennheiser/McpBus';
import { WebRTCSignaling } from '../audio/WebRTCSignaling';
import { AES67Manager } from '../audio/AES67Manager';

export default fp(async (fastify, opts) => {
  const io = new Server(fastify.server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  const deviceManager = new DeviceManagerService(io);
  const audioManager = new AES67Manager();
  const webrtcSignaling = new WebRTCSignaling(io, audioManager);

  fastify.decorate('io', io);
  fastify.decorate('deviceManager', deviceManager);
  fastify.decorate('audioManager', audioManager);

  // Forward mDNS discovery events to all connected frontend clients
  deviceManager.on('device:discovered', (device: DiscoveredDevice) => {
    io.emit('device:discovered', {
      key: `${device.ip}:${device.port}`,
      name: device.name,
      ip: device.ip,
      port: device.port,
      manufacturer: inferManufacturer(device.name, device.protocol),
      model: inferModel(device.name, device.protocol),
    });
  });

  deviceManager.on('device:online', (device: { ip: string; port: number }) => {
    io.emit('device:online', { ip: device.ip, port: device.port });
  });

  deviceManager.on('device:lost', (device: { ip: string; port: number }) => {
    io.emit('device:lost', { ip: device.ip, port: device.port });
  });

  // Forward discovery scan progress to the frontend so it can show/hide a spinner.
  (deviceManager as any).discovery.on('scan:start',    () => io.emit('discovery:scan-start'));
  (deviceManager as any).discovery.on('scan:complete', () => io.emit('discovery:scan-complete'));

  fastify.addHook('onReady', async () => {
    await mcpBus.init(); // shared UDP :53212 must be ready before any G3G4Client or DiscoveryService
    deviceManager.start();
    fastify.log.info('Socket.io server listening and DeviceManager started');
  });

  fastify.addHook('onClose', async () => {
    deviceManager.stop();
    mcpBus.close();
    audioManager.stop();
    io.close();
  });

  io.on('connection', (socket) => {
    fastify.log.info(`Client connected: ${socket.id}`);

    // Replay current state so a freshly-connected (or reconnected) frontend
    // immediately shows the right device online/discovered status and channel data.
    // Online status MUST arrive before channel telemetry so ChannelStrip doesn't
    // flash the "Device Offline" overlay while the device is actually connected.
    for (const device of deviceManager.getOnlineDevices()) {
      socket.emit('device:online', device);
    }
    for (const channel of deviceManager.getChannelSnapshot()) {
      socket.emit('channel:telemetry', channel);
    }
    for (const device of deviceManager.getDiscoveredSnapshot()) {
      socket.emit('device:discovered', {
        key: `${device.ip}:${device.port}`,
        name: device.name,
        ip: device.ip,
        port: device.port,
        manufacturer: inferManufacturer(device.name, device.protocol),
        model: inferModel(device.name, device.protocol),
      });
    }

    webrtcSignaling.attach(socket);

    socket.on('audio:start-test', () => {
      audioManager.startTestTone();
    });

    socket.on('audio:start-aes67', ({ ip, port }) => {
      audioManager.startAES67Stream(ip, port);
    });

    socket.on('audio:stop', () => {
      audioManager.stop();
    });

    // Hardware Control Commands
    socket.on('channel:mute', async ({ deviceId, rxIndex, muted }) => {
      await deviceManager.muteChannel(deviceId, rxIndex, muted);
    });

    socket.on('channel:gain', async ({ deviceId, rxIndex, gain }) => {
      await deviceManager.setChannelGain(deviceId, rxIndex, gain);
    });

    socket.on('channel:frequency', async ({ deviceId, rxIndex, frequencyHz }) => {
      await deviceManager.setChannelFrequency(deviceId, rxIndex, frequencyHz);
    });

    socket.on('device:identify', async ({ deviceId }) => {
      await deviceManager.identifyDevice(deviceId);
    });

    socket.on('device:network', async ({ deviceId, staticIp, subnet, gateway }) => {
      await deviceManager.setDeviceNetwork(deviceId, staticIp, subnet, gateway);
    });


    socket.on('disconnect', () => {
      fastify.log.info(`Client disconnected: ${socket.id}`);
    });
  });
});


function inferManufacturer(name: string, protocol: string): string {
  // MCP is exclusively used by Sennheiser G3/G4 EW-series hardware
  if (protocol === 'mcp') return 'Sennheiser';
  const n = name.toLowerCase();
  if (n.includes('sennheiser') || n.includes('ew-dx') || n.includes('em ') || protocol.includes('ssc')) {
    return 'Sennheiser';
  }
  if (n.includes('shure') || n.includes('ad4') || n.includes('ulxd') || n.includes('axient')) {
    return 'Shure';
  }
  return 'Unknown';
}

function inferModel(name: string, protocol: string): string {
  // For MCP devices the device-reported `name` is the channel label ("Vocal 1"),
  // not the hardware model. Return a generic model string instead.
  if (protocol === 'mcp') return 'EW G3/G4';
  // Strip common suffixes like hostname appended via Bonjour (_ssc._tcp.local etc.)
  return name.replace(/\s*\(.*?\)\s*/g, '').trim() || 'Unknown Model';
}

