import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import {
  listAudioInputDevices, describeNoDevices, audioSubsystemPresent, clearChannelCache,
  describeAccessProblem, backendSummary,
} from '../audio/deviceList';
import { log } from '../logger';

// Audio devices belong to the SERVER — the interface carrying the receiver
// outputs is plugged into this machine, not into whichever laptop is viewing
// the dashboard. The patch map lives here too, so every client sees the same
// wiring rather than each keeping a private guess at it.

export const audioRoutes: FastifyPluginAsync = async (fastify) => {
  // Every capture device on this machine, with the input count each reports.
  fastify.get('/audio/devices', async (request) => {
    const q = request.query as Record<string, string | undefined>;
    // A rescan should re-read hardware that has been plugged in since boot.
    if (q.rescan === '1') clearChannelCache();

    const devices = listAudioInputDevices();
    const assignments = await prisma.channelAudioMap.findMany();

    // A device list that is present but unopenable needs its own explanation:
    // it looks healthy while nothing about it works.
    const accessProblem = describeAccessProblem();

    return {
      devices,
      assignments,
      hint: devices.length === 0 ? describeNoDevices() : accessProblem,
      accessProblem,
      subsystemPresent: audioSubsystemPresent(),
      // Which capture path this machine is actually using, and where its
      // ffmpeg came from. "No devices" on a desktop install is almost always
      // a missing binary rather than missing hardware, and that is impossible
      // to tell apart from the device list alone.
      backend: backendSummary(),
    };
  });

  // Patch one RF channel to one input of one device.
  fastify.put('/audio/assignments/:channelKey', async (request, reply) => {
    const { channelKey } = request.params as { channelKey: string };
    const { deviceId, inputChannel } = request.body as {
      deviceId: string | null;
      inputChannel: number | null;
    };

    // Clearing the patch.
    if (!deviceId || !inputChannel) {
      await prisma.channelAudioMap.deleteMany({ where: { channelKey } });
      (fastify as any).io?.emit('audio:assignments-changed');
      // Recording follows the patch: unpatching stops the tap.
      (fastify as any).recordingManager?.reload().catch(() => {});
      return { channelKey, deviceId: null, inputChannel: null };
    }

    // Validate against what the hardware actually offers, so a patch cannot
    // point at an input that does not exist — it would fail silently at listen
    // time, long after the mistake was made.
    const device = listAudioInputDevices().find(d => d.id === deviceId);
    if (!device) {
      return reply.code(400).send({ error: `No such capture device: ${deviceId}` });
    }
    if (inputChannel < 1 || inputChannel > device.channels) {
      return reply.code(400).send({
        error: `${device.label} has ${device.channels} input(s); ${inputChannel} is out of range`,
      });
    }

    const saved = await prisma.channelAudioMap.upsert({
      where:  { channelKey },
      create: { channelKey, deviceId, inputChannel },
      update: { deviceId, inputChannel },
    });

    log.info(`[audio] ${channelKey} patched to ${deviceId} input ${inputChannel}`);
    (fastify as any).io?.emit('audio:assignments-changed');
    // A newly patched channel starts recording immediately — there is no
    // separate switch to remember.
    (fastify as any).recordingManager?.reload().catch(() => {});
    return saved;
  });

  // What is currently being listened to, for diagnostics.
  fastify.get('/audio/active', async () => {
    return { active: (fastify as any).captureManager.activeChannels() };
  });
};
