import fp from 'fastify-plugin';
import { Server } from 'socket.io';
import { DeviceManagerService } from '../hardware/sennheiser/DeviceManagerService';
import { DiscoveredDevice } from '../hardware/sennheiser/DiscoveryService';
import { mcpBus } from '../hardware/sennheiser/McpBus';
import { WebRTCSignaling } from '../audio/WebRTCSignaling';
import { AES67Manager } from '../audio/AES67Manager';
import { CaptureManager } from '../audio/CaptureManager';
import { RecordingManager } from '../recording/RecordingManager';
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
  // The audio detectors ask the RF side what it knows before reporting
  // anything ambiguous — see docs/AUDIO_DETECTION.md.
  const recordingManager = new RecordingManager(captureManager, io, (channelKey) => {
    const ch = deviceManager.getChannelSnapshot().find(c => c.name === channelKey);
    if (!ch) return { marginal: false, muted: false };
    return {
      // Below the healthy band, or already in dropout.
      marginal: ch.rfLevelA < 35 || ch.status === 'CRITICAL',
      // Silence on a muted channel is deliberate, not a fault.
      muted: ch.isMuted === true || ch.isTxMuted === true,
    };
  });
  const webrtcSignaling = new WebRTCSignaling(io, audioManager, captureManager);

  fastify.decorate('io', io);
  fastify.decorate('deviceManager', deviceManager);
  fastify.decorate('audioManager', audioManager);
  fastify.decorate('captureManager', captureManager);
  fastify.decorate('recordingManager', recordingManager);

  // Detections keep the audio that proves them.
  deviceManager.on('rf:detection', (input: any) => {
    void recordingManager.record(input);
  });

  // Forward mDNS discovery events to all connected frontend clients
  deviceManager.on('device:discovered', (device: DiscoveredDevice) => {
    io.emit('device:discovered', {
      key: `${device.ip}:${device.port}`,
      name: device.name,
      ip: device.ip,
      port: device.port,
      manufacturer: inferManufacturer(device.name, device.protocol, device.manufacturer),
      model: inferModel(device.name, device.protocol, device.model),
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

    // Recording follows the audio patch, so it starts once and then only on
    // patch changes. Never fatal: a server that cannot record must still monitor.
    recordingManager.start().catch(err =>
      log.warn(`[recording] Could not start rolling capture: ${err?.message}`));

    fastify.log.info('Socket.io server listening and DeviceManager started');
  });

  fastify.addHook('onClose', async () => {
    if (heartbeat) clearInterval(heartbeat);
    deviceManager.stop();
    mcpBus.close();
    audioManager.stop();
    recordingManager.stopAll();
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

      // A Micboard display may connect without a PIN, because the PIN exists
      // to prevent unauthorised changes rather than to hide telemetry. It is
      // marked read-only and the control handlers below are never registered
      // for it, so this is a structural guarantee rather than a promise that
      // the page will not ask.
      if (socket.handshake.auth?.micboard === true) {
        socket.data.readOnly = true;
        return next();
      }

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
        manufacturer: inferManufacturer(device.name, device.protocol, device.manufacturer),
        model: inferModel(device.name, device.protocol, device.model),
      });
    }

    // A read-only client has now had the full state replay above and will keep
    // receiving broadcasts. Nothing below this line is wired up for it: no
    // control commands, and no audio signalling, since opening a capture is
    // itself an action on the hardware.
    if (socket.data.readOnly) {
      fastify.log.info(`Client ${socket.id} connected read-only (Micboard)`);
      socket.on('disconnect', () => {
        fastify.log.info(`Read-only client disconnected: ${socket.id}`);
      });
      return;
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


// Discovery sometimes knows outright, having probed the device — in which case
// nothing here should second-guess it. These heuristics exist for the paths
// that only ever learn a name.
function inferManufacturer(name: string, protocol: string, known?: string): string {
  if (known) return known;
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

function inferModel(name: string, protocol: string, known?: string): string {
  if (known) return known;
  // For MCP devices the device-reported `name` is the channel label ("Vocal 1"),
  // not the hardware model. Return a generic model string instead.
  if (protocol === 'mcp') return 'EW G3/G4';
  // A Shure device's name is its DEVICE_ID — "Rack1", "FOH" — which is not a
  // model and must never be filed as one, because the model chooses the
  // protocol dialect. If the probe could not read a MODEL (ULX-D has no such
  // parameter), say so rather than inventing one.
  if (protocol === 'shure') return 'Unknown Shure model';
  // Strip common suffixes like hostname appended via Bonjour (_ssc._tcp.local etc.)
  return name.replace(/\s*\(.*?\)\s*/g, '').trim() || 'Unknown Model';
}

