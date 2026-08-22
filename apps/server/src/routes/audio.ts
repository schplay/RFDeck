import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { listAudioInputDevices, describeNoDevices, audioSubsystemPresent } from '../audio/deviceList';
import { log } from '../logger';

// Audio devices belong to the SERVER.
//
// The interface carrying the receiver outputs is plugged into this machine, so
// the device list and the selection both live here. A browser enumerating its
// own hardware would offer the operator their laptop's built-in microphone.

export const audioRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/audio/devices', async () => {
    const devices = listAudioInputDevices();
    const settings = await prisma.settings.findFirst();

    return {
      devices,
      selected: settings?.audioInputDevice ?? null,
      // Explain an empty list rather than leaving the UI to guess.
      hint: devices.length === 0 ? describeNoDevices() : null,
      alsaPresent: audioSubsystemPresent(),
    };
  });

  fastify.put('/audio/device', async (request, reply) => {
    const { deviceId } = request.body as { deviceId: string | null };

    // Reject anything not currently present, so a stale selection from an
    // interface that has been unplugged cannot silently do nothing.
    if (deviceId) {
      const known = listAudioInputDevices().some(d => d.id === deviceId);
      if (!known) {
        return reply.code(400).send({ error: `No such capture device: ${deviceId}` });
      }
    }

    let settings = await prisma.settings.findFirst();
    if (!settings) settings = await prisma.settings.create({ data: {} });

    await prisma.settings.update({
      where: { id: settings.id },
      data: { audioInputDevice: deviceId },
    });

    const audioManager = (fastify as any).audioManager;
    if (deviceId) {
      audioManager.startLocalCapture(deviceId);
      log.info(`Monitoring audio source set to ${deviceId}`);
    } else {
      audioManager.stop();
      log.info('Monitoring audio source cleared');
    }

    return { selected: deviceId };
  });
};
