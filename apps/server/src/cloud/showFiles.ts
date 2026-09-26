import { prisma } from '../db';
import { log } from '../logger';
import { showInclude } from '../routes/shows';
import { buildShowFile, parseShowFile, showFileKey, ShowFile } from './showFile';
import { Documents, DocumentConflict, contentHash } from './documents';

/**
 * Show files, between the database and document sync.
 *
 * The protocol lives in `documents.ts` and the format in `showFile.ts`; this is
 * the part that knows about RFDeck's tables. Push and pull are explicit operator
 * actions — "save this show to the cloud", "open my show from last week" — never a
 * background sync on a live rig.
 */

const COLLECTION = 'shows';

export interface CloudShowSummary {
  key: string;
  headVersion: number;
  updatedAt: string;
  /** The show's name, when this machine already has it locally. */
  localName: string | null;
  /** True when this machine has the show and it matches what the cloud holds. */
  inSync: boolean;
}

export class ShowFiles {
  constructor(private readonly documents: Documents) {}

  private async bookmark(key: string) {
    return prisma.cloudDocument.findUnique({ where: { path: `${COLLECTION}/${key}` } });
  }

  private async remember(key: string, version: number, hash: string | null, pulled = false) {
    const path = `${COLLECTION}/${key}`;
    const data = {
      path, collection: COLLECTION, key, version,
      contentHash: hash,
      ...(pulled ? { pulledAt: new Date() } : { pushedAt: new Date() }),
    };
    await prisma.cloudDocument.upsert({ where: { path }, create: data, update: data });
  }

  /** Build the file for a show, or null when there is no such show. */
  async build(showId: string): Promise<ShowFile | null> {
    const row = await prisma.show.findUnique({ where: { id: showId }, include: showInclude as any });
    return row ? buildShowFile(row) : null;
  }

  /**
   * Push a show to the cloud.
   *
   * Carries the version this machine last saw. A stale one comes back as a
   * `DocumentConflict` rather than an overwrite, and the caller decides — except
   * for the one case that needs no decision: the cloud already holding a
   * byte-identical copy, which is simply recorded and reported as up to date.
   */
  async push(showId: string): Promise<
    | { status: 'pushed'; version: number }
    | { status: 'already-current'; version: number }
    | { status: 'conflict'; conflict: DocumentConflict }
  > {
    const file = await this.build(showId);
    if (!file) throw new Error('No such show.');
    const key = showFileKey(showId);
    const known = await this.bookmark(key);

    try {
      const result = await this.documents.put(COLLECTION, key, file, known?.version ?? undefined);
      await this.remember(key, result.version, result.content_hash ?? contentHash(file));
      log.info(`[Cloud] Pushed show "${file.show.name}" as version ${result.version}`);
      return { status: 'pushed', version: result.version };
    } catch (err) {
      if (err instanceof DocumentConflict) {
        if (err.sameContent) {
          // Two machines, one show, nothing to resolve. Catch up our bookmark so
          // the next real edit pushes cleanly instead of conflicting again.
          await this.remember(key, err.headVersion, err.headContentHash);
          return { status: 'already-current', version: err.headVersion };
        }
        return { status: 'conflict', conflict: err };
      }
      throw err;
    }
  }

  /**
   * Take the cloud's copy and apply it locally.
   *
   * Applied in a transaction, and cast and mic-check rows are replaced rather
   * than merged: the file is a snapshot of a show, and half-merging two casts
   * would produce a list nobody wrote. `force` is the answer to a conflict the
   * operator resolved in the cloud's favour.
   */
  async pull(showId: string, version?: number): Promise<{ name: string; version: number }> {
    const key = showFileKey(showId);
    const fetched = await this.documents.get(COLLECTION, key, version);
    const file = parseShowFile(fetched.body);
    await this.apply(showId, file);
    await this.remember(key, fetched.version, fetched.content_hash, true);
    log.info(`[Cloud] Pulled show "${file.show.name}" at version ${fetched.version}`);
    return { name: file.show.name, version: fetched.version };
  }

  /**
   * Write a show file into the database, creating the show if it is not there.
   *
   * One transaction, because a show whose cast applied and whose mic check did
   * not is worse than one that failed outright — the operator would not know
   * which half they were looking at.
   */
  async apply(showId: string, file: ShowFile): Promise<void> {
    // Performers are matched by roster id where this machine shares the roster.
    // A file from a machine that does not is still usable: the copied names come
    // through and the castings are simply unlinked.
    const known = new Set(
      (await prisma.performer.findMany({ select: { id: true } })).map(p => p.id),
    );

    await prisma.$transaction(async (tx) => {
      await tx.show.upsert({
        where: { id: showId },
        create: { id: showId, ...file.show },
        update: file.show,
      });

      // Replaced wholesale. Quick changes cascade with their player.
      await tx.player.deleteMany({ where: { showId } });
      for (const player of file.players) {
        await tx.player.create({
          data: {
            showId,
            performerId: player.performerId && known.has(player.performerId) ? player.performerId : null,
            realName: player.realName,
            characterName: player.characterName,
            notes: player.notes,
            assignedChannelKey: player.assignedChannelKey,
            iemChannelKey: player.iemChannelKey,
            sortIndex: player.sortIndex,
            quickChanges: {
              create: player.quickChanges.map(q => ({
                act: q.act, outCue: q.outCue, inCue: q.inCue,
                notes: q.notes, sortIndex: q.sortIndex,
              })),
            },
          },
        });
      }

      await tx.micCheckEntry.deleteMany({ where: { showId } });
      if (file.micCheck.length > 0) {
        await tx.micCheckEntry.createMany({
          data: file.micCheck.map(e => ({
            showId, act: e.act, channelKey: e.channelKey, checked: e.checked,
            checkedAt: e.checkedAt ? new Date(e.checkedAt) : null,
            checkedBy: e.checkedBy, notes: e.notes,
          })),
        });
      }
    });
  }

  /**
   * What is in the cloud, annotated with what this machine knows.
   *
   * The annotation is the useful part: an "Open from cloud" list of opaque uuids
   * is no use, and an operator mainly wants to know which of these they already
   * have and whether it differs from theirs.
   */
  async list(): Promise<CloudShowSummary[]> {
    const listing = await this.documents.list(COLLECTION);
    const localShows = await prisma.show.findMany({ select: { id: true, name: true } });
    const localById = new Map(localShows.map(s => [s.id, s.name]));

    const summaries: CloudShowSummary[] = [];
    for (const doc of listing.documents ?? []) {
      const known = await this.bookmark(doc.key);
      let inSync = false;
      if (localById.has(doc.key) && known?.version === doc.head_version) {
        // Same version *and* our copy has not been edited since we last synced.
        const current = await this.build(doc.key);
        inSync = !!current && !!known.contentHash && contentHash(current) === known.contentHash;
      }
      summaries.push({
        key: doc.key,
        headVersion: doc.head_version,
        updatedAt: doc.updated_at,
        localName: localById.get(doc.key) ?? null,
        inSync,
      });
    }
    return summaries;
  }
}
