import { prisma } from '../db';
import { log } from '../logger';

// The performer roster: people, independent of any show.
//
// A show's cast list used to own its names outright, so the same person typed
// into three shows was three unrelated strings. The roster makes them one
// record, cast into shows by reference. Castings keep a copy of the name so a
// show still reads correctly if the person is removed from the roster; the
// copy is refreshed here whenever the performer is renamed.

export const performerInclude = {
  _count: { select: { castings: true } },
} as const;

export function serializePerformer(row: any) {
  return {
    id:           row.id,
    name:         row.name,
    notes:        row.notes ?? '',
    fitNotes:     row.fitNotes ?? '',
    // The client is given a URL, never the filename — where the file lives is
    // the server's business and the path is not something a client can forge.
    photoUrl:     row.photoPath ? `/performers/${row.id}/photo` : null,
    castingCount: row._count?.castings ?? 0,
    createdAt:    row.createdAt.toISOString(),
    updatedAt:    row.updatedAt.toISOString(),
  };
}

export async function listPerformers() {
  const rows = await prisma.performer.findMany({
    include: performerInclude,
    orderBy: { name: 'asc' },
  });
  return rows.map(serializePerformer);
}

// Match on the trimmed, case-folded name. SQLite's default collation is
// case-sensitive, and "Jane Doe" typed twice with different capitalisation is
// one person, not two.
export async function findOrCreatePerformer(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Performer name is required');

  const folded = trimmed.toLowerCase();
  const candidates = await prisma.performer.findMany({
    where: { name: { contains: trimmed.slice(0, 1) } },
  });
  const existing = candidates.find(p => p.name.trim().toLowerCase() === folded);
  if (existing) return existing;

  return prisma.performer.create({ data: { name: trimmed } });
}

// Link castings that predate the roster to performers, creating roster
// entries from their names. Runs at every start; a no-op once everything is
// linked, and safe to interrupt since each casting is linked individually.
export async function backfillPerformers(): Promise<void> {
  const orphans = await prisma.player.findMany({ where: { performerId: null } });
  if (orphans.length === 0) return;

  let linked = 0;
  for (const casting of orphans) {
    const name = casting.realName.trim();
    if (!name) continue;
    const performer = await findOrCreatePerformer(name);
    await prisma.player.update({
      where: { id: casting.id },
      data:  { performerId: performer.id, realName: performer.name },
    });
    linked++;
  }
  log.info(`[performers] Linked ${linked} existing cast entr${linked === 1 ? 'y' : 'ies'} to the roster`);
}
