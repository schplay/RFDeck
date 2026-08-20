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
      }
    });

    const { defaultPassword, authPinHash, ...safe } = settings;
    return { ...safe, hasDefaultPassword: !!defaultPassword, pinIsSet: !!authPinHash };
  });
};
