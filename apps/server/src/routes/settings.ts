import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';
import { encryptSecret } from '../auth/secretBox';

export const settingsRoutes: FastifyPluginAsync = async (fastify, options) => {
  // GET global settings.
  // Never return credential material or the PIN hash to a client — only whether
  // each is configured.
  fastify.get('/settings', async (request, reply) => {
    let settings = await prisma.settings.findFirst();
    if (!settings) {
      settings = await prisma.settings.create({ data: {} });
    }
    const { defaultPassword, authPinHash, ...safe } = settings;
    return {
      ...safe,
      hasDefaultPassword: !!defaultPassword,
      pinIsSet: !!authPinHash,
    };
  });

  // PUT update global settings
  fastify.put('/settings', async (request, reply) => {
    const data = request.body as any;
    
    let settings = await prisma.settings.findFirst();
    if (!settings) {
      settings = await prisma.settings.create({ data: {} });
    }

    settings = await prisma.settings.update({
      where: { id: settings.id },
      data: {
        aes67MulticastIp:   data.aes67MulticastIp,
        aes67Port:           data.aes67Port,
        batteryWarningPct:   data.batteryWarningPct,
        batteryCriticalPct:  data.batteryCriticalPct,
        dropoutSensitivity:  data.dropoutSensitivity,
        bindInterface:       data.bindInterface,
        // Encrypted at rest — this unlocks wireless hardware. A blank string
        // means "leave unchanged" rather than "clear", so a user editing other
        // settings doesn't wipe a stored credential.
        defaultPassword:     Object.prototype.hasOwnProperty.call(data, 'defaultPassword')
                               ? (data.defaultPassword
                                    ? encryptSecret(data.defaultPassword)
                                    : undefined)
                               : undefined,

        // ── Rolling capture ──
        recordingEnabled: typeof data.recordingEnabled === 'boolean'
                            ? data.recordingEnabled : undefined,
        // Clamped rather than trusted: a zero or negative budget would prune
        // every clip the moment it was written.
        recordingMaxMb:   typeof data.recordingMaxMb === 'number'
                            ? Math.max(64, Math.round(data.recordingMaxMb)) : undefined,
        recordingPreSec:  typeof data.recordingPreSec === 'number'
                            ? Math.min(120, Math.max(1, Math.round(data.recordingPreSec))) : undefined,
        recordingPostSec: typeof data.recordingPostSec === 'number'
                            ? Math.min(120, Math.max(0, Math.round(data.recordingPostSec))) : undefined,
      }
    });

    // Recording reads its configuration once and holds taps open, so it has to
    // be told when any of it changes.
    const touchedRecording = ['recordingEnabled', 'recordingMaxMb', 'recordingPreSec', 'recordingPostSec']
      .some(k => Object.prototype.hasOwnProperty.call(data, k));
    if (touchedRecording) {
      (fastify as any).recordingManager?.reload().catch(() => {});
    }

    const { defaultPassword, authPinHash, ...safe } = settings;
    return { ...safe, hasDefaultPassword: !!defaultPassword, pinIsSet: !!authPinHash };
  });
};
