import fp from 'fastify-plugin';
import { Server } from 'socket.io';
import { DeviceManagerService } from '../hardware/sennheiser/DeviceManagerService';
import { DiscoveredDevice } from '../hardware/sennheiser/DiscoveryService';
import { mcpBus } from '../hardware/sennheiser/McpBus';
import { WebRTCSignaling } from '../audio/WebRTCSignaling';
import { AES67Manager } from '../audio/AES67Manager';
import { CaptureManager } from '../audio/CaptureManager';
import { listAudioInputDevices } from '../audio/deviceList';
import { prisma } from '../db';
import { log } from '../logger';
import { isRequestAuthorized } from '../auth/pinAuth';

export default fp(async (fastify, opts) => {
  const io = new Server(fastify.server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  const deviceManager = new DeviceManagerService(io);
  const audioManager = new AES67Manager();
  const captureManager = new CaptureManager();
  const webrtcSignaling = new WebRTCSignaling(io, audioManager, captureManager);

  fastify.decorate('io', io);
  fastify.decorate('deviceManager', deviceManager);
  fastify.decorate('audioManager', audioManager);
  fastify.decorate('captureManager', captureManager);

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

  // Liveness broadcast. Telemetry is sent on change only, so a receiver with a
  // mic that is on but silent produces nothing — and clients must not read that
  // as a frozen feed. This says, every two seconds, which devices are actually
  // in contact, independent of whether any value moved.
  let heartbeat: NodeJS.Timeout | null = null;
  const HEARTBEAT_MS = 2_000;

  fastify.addHook('onReady', async () => {
    await mcpBus.init(); // shared UDP :53212 must be ready before any G3G4Client or DiscoveryService
    deviceManager.start();
    heartbeat = setInterval(() => {
      io.emit('device:heartbeat', deviceManager.getHeartbeat());
    }, HEARTBEAT_MS);

    fastify.log.info('Socket.io server listening and DeviceManager started');
  });

  fastify.addHook('onClose', async () => {
    if (heartbeat) clearInterval(heartbeat);
    deviceManager.stop();
    mcpBus.close();
    audioManager.stop();
    io.close();
  });

  // PIN gate for realtime traffic. Control commands (mute, gain, frequency)
  // arrive over the socket rather than REST, so guarding only REST would leave
  // the actual attack surface open. No-op on the default open configuration.
  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth?.token
                  ?? socket.handshake.headers['x-rfdeck-token']) as string | undefined;
      const ip = socket.handshake.address;
      if (await isRequestAuthorized(ip, token)) return next();
      next(new Error('PIN_REQUIRED'));
    } catch {
      // Never fail closed on an internal error — a database hiccup must not
      // black out a live show on an installation that has no PIN configured.
      next();
    }
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
    // Liveness too, so a fresh client is not left guessing until the next
    // broadcast and does not flash every channel as stale on arrival.
    socket.emit('device:heartbeat', deviceManager.getHeartbeat());
    // Devices refusing their password — a client arriving after the refusal
    // would otherwise see them as simply online.
    for (const f of deviceManager.getAuthFailures()) {
      socket.emit('device:auth', { ...f, failed: true });
    }
    for (const channel of deviceManager.getChannelSnapshot()) {
      socket.emit('channel:telemetry', channel);
    }
    // RF events and alerts are computed server-side, so replay them to a client
    // joining mid-show rather than leaving it with an empty log.
    for (const event of deviceManager.getRfEventSnapshot().slice().reverse()) {
      socket.emit('rf:event', event);
    }
    for (const alert of deviceManager.getAlertSnapshot().slice().reverse()) {
      socket.emit('alert:new', alert);
    }
    // Battery projections are built from server-held history, so a fresh client
    // gets them immediately rather than waiting to accumulate its own.
    for (const est of deviceManager.getBatteryEstimateSnapshot()) {
      socket.emit('battery:estimate', est);
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
    // Every control command answers the sender. Hardware state echoes back
    // as telemetry when a command works; when it does not, nothing changes and
    // the operator is left pressing a button that appears to do nothing. The
    // failure was only ever in the server log.
    const report = (action: string, deviceId: string, rxIndex: number, ok: boolean) => {
      socket.emit('control:result', {
        action, deviceId, rxIndex, ok,
        message: ok ? null : `${action} was refused by the device — see the server log for the reason`,
      });
    };

    socket.on('channel:mute', async ({ deviceId, rxIndex, muted }) => {
      const ok = await deviceManager.muteChannel(deviceId, rxIndex, muted);
      report(muted ? 'Mute' : 'Unmute', deviceId, rxIndex, !!ok);
    });

    socket.on('channel:gain', async ({ deviceId, rxIndex, gain }) => {
      const ok = await deviceManager.setChannelGain(deviceId, rxIndex, gain);
      report('Gain change', deviceId, rxIndex, !!ok);
    });

    socket.on('channel:frequency', async ({ deviceId, rxIndex, frequencyHz }) => {
      const ok = await deviceManager.setChannelFrequency(deviceId, rxIndex, frequencyHz);
      report('Frequency change', deviceId, rxIndex, !!ok);
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

