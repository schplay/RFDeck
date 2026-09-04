import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../db';

// What the Micboard display needs that telemetry does not carry: who is on
// each channel, and their photo.
//
// Deliberately its own endpoint rather than reusing /shows. The PIN exists to
// stop unauthorised *changes*, so a wall display is allowed to read without
// one — and that exemption should expose exactly what a display needs, not the
// whole inventory, event log and show history by implication.

export const micboardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/micboard', async () => {
    // The show being run now. Same rule the detection recorder uses: most
    // recently touched show that has not been archived.
    const show = await prisma.show.findFirst({
      where: { archived: false },
      orderBy: { updatedAt: 'desc' },
      include: {
        players: {
          orderBy: { sortIndex: 'asc' },
          include: { performer: true },
        },
      },
    });

    // channelKey -> who is on it. Keyed by channel NAME, as everywhere else,
    // so it survives a receiver changing address.
    const assignments: Record<string, {
      name: string;
      role: string;
      photoUrl: string | null;
      isIem: boolean;
    }> = {};

    for (const p of show?.players ?? []) {
      const photoUrl = p.performer?.photoPath
        ? `/performers/${p.performer.id}/photo?v=${encodeURIComponent(p.performer.updatedAt.toISOString())}`
        : null;

      if (p.assignedChannelKey) {
        assignments[p.assignedChannelKey] = {
          name: p.realName, role: p.characterName ?? '', photoUrl, isIem: false,
        };
      }
      // The same person's IEM gets their name too — an A2 looking at a pack
      // with a failing battery needs to know whose ear it is in.
      if (p.iemChannelKey) {
        assignments[p.iemChannelKey] = {
          name: p.realName, role: p.characterName ?? '', photoUrl, isIem: true,
        };
      }
    }

    return {
      show: show ? { id: show.id, name: show.name, currentAct: show.currentAct } : null,
      assignments,
    };
  });
};
