/**
 * The show file: a show made portable.
 *
 * Everything about a production that is worth carrying between machines and
 * venues — the show, its periods, its cast, their channel assignments, quick
 * changes and the mic-check state — and nothing that is a property of a
 * particular rig at a particular moment. No telemetry, no clips, no audio.
 *
 * Deliberately *not* the show report. The report is a printed artefact and is
 * lossy on purpose (it resolves names, counts ticks, formats times). A show file
 * has to survive a round trip, so it keeps ids and raw values and leaves the
 * presenting to whoever reads it.
 *
 * Both halves live here — build and apply — because a format with its writer and
 * reader in one file is a format that stays symmetrical. The test asserts that
 * directly: build, apply, build again, and the two files must be identical.
 */

export const SHOW_FILE_VERSION = 1;

export interface ShowFileQuickChange {
  act: number | null;
  outCue: string;
  inCue: string;
  notes: string;
  sortIndex: number;
}

export interface ShowFilePlayer {
  /**
   * The performer's roster id, when they are on it.
   *
   * Carried so that pulling a show onto a machine that shares the roster
   * re-links the same people. On a machine that does not know them, `realName`
   * is what survives — which is why the name is stored alongside rather than
   * looked up.
   */
  performerId: string | null;
  realName: string;
  characterName: string;
  notes: string;
  /** Stable channel ids: the inventory row's uuid and the receiver slot. */
  assignedChannelKey: string | null;
  iemChannelKey: string | null;
  sortIndex: number;
  quickChanges: ShowFileQuickChange[];
}

export interface ShowFileMicCheckEntry {
  act: number;
  channelKey: string;
  checked: boolean;
  checkedAt: string | null;
  checkedBy: string | null;
  notes: string | null;
}

export interface ShowFile {
  /** Format version. Bumped only for a change a reader could not survive. */
  showFile: number;
  /** When this file was written, for display in an "Open from cloud" list. */
  exportedAt: string;
  show: {
    name: string;
    environmentMode: string;
    date: string | null;
    venue: string | null;
    notes: string | null;
    periodCount: number;
    currentAct: number;
  };
  players: ShowFilePlayer[];
  micCheck: ShowFileMicCheckEntry[];
}

/** The document key a show is stored under. The show's own uuid. */
export function showFileKey(showId: string): string {
  // Meros accepts /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/ and a uuid fits, so there
  // is nothing to sanitise — but assert it rather than discover a 422 in a venue.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/.test(showId)) {
    throw new Error(`Show id "${showId}" cannot be used as a document key`);
  }
  return showId;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function whole(value: unknown, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build a show file from a Prisma show loaded with `showInclude`.
 *
 * Field order is fixed rather than incidental, because two files that differ only
 * in key order have different `content_hash`es, and document sync uses that hash
 * to tell an operator whether a 409 is a real conflict or the same show twice.
 */
export function buildShowFile(row: any, now: Date = new Date()): ShowFile {
  const players: ShowFilePlayer[] = [...(row.players ?? [])]
    .sort((a: any, b: any) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
    .map((p: any) => ({
      performerId: p.performerId ?? null,
      realName: text(p.realName),
      characterName: text(p.characterName),
      notes: text(p.notes),
      assignedChannelKey: p.assignedChannelKey ?? null,
      iemChannelKey: p.iemChannelKey ?? null,
      sortIndex: whole(p.sortIndex, 0),
      quickChanges: [...(p.quickChanges ?? [])]
        .sort((a: any, b: any) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        .map((q: any) => ({
          act: q.act ?? null,
          outCue: text(q.outCue),
          inCue: text(q.inCue),
          notes: text(q.notes),
          sortIndex: whole(q.sortIndex, 0),
        })),
    }));

  // Sorted so the file is stable across exports: Prisma's row order for
  // micCheck is not guaranteed, and an unstable order would make every push
  // look like a change.
  const micCheck: ShowFileMicCheckEntry[] = [...(row.micCheck ?? [])]
    .map((e: any) => ({
      act: whole(e.act, 1),
      channelKey: text(e.channelKey),
      checked: e.checked === true,
      checkedAt: e.checkedAt instanceof Date ? e.checkedAt.toISOString() : nullableText(e.checkedAt),
      checkedBy: nullableText(e.checkedBy),
      notes: nullableText(e.notes),
    }))
    .sort((a, b) => a.act - b.act || a.channelKey.localeCompare(b.channelKey));

  return {
    showFile: SHOW_FILE_VERSION,
    exportedAt: now.toISOString(),
    show: {
      name: text(row.name, 'Untitled show'),
      environmentMode: text(row.environmentMode, 'THEATER'),
      date: nullableText(row.date),
      venue: nullableText(row.venue),
      notes: nullableText(row.notes),
      periodCount: whole(row.periodCount, 4),
      currentAct: whole(row.currentAct, 1),
    },
    players,
    micCheck,
  };
}

export class ShowFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShowFileError';
  }
}

/**
 * Validate and normalise a show file that came from the cloud.
 *
 * Everything arriving over a network is untrusted, including a file this
 * application wrote: it may have been written by a newer build, or by a version
 * with a bug. So this coerces rather than trusts, and refuses only the two things
 * it genuinely cannot work around — a version it does not understand, and a
 * missing show name.
 */
export function parseShowFile(input: unknown): ShowFile {
  if (!input || typeof input !== 'object') {
    throw new ShowFileError('That is not a show file.');
  }
  const raw = input as any;
  const version = whole(raw.showFile, 0);
  if (version < 1) {
    throw new ShowFileError('That file does not say which show-file version it is.');
  }
  if (version > SHOW_FILE_VERSION) {
    // Forward compatibility is a promise we have not made, and silently
    // dropping fields an operator can see in the cloud would be worse than
    // refusing.
    throw new ShowFileError(
      `That show file was written by a newer version of RFDeck ` +
      `(format ${version}; this build understands ${SHOW_FILE_VERSION}). Update and try again.`,
    );
  }
  const show = raw.show;
  if (!show || typeof show !== 'object' || !text(show.name).trim()) {
    throw new ShowFileError('That show file has no show name.');
  }

  const periodCount = Math.min(12, Math.max(1, whole(show.periodCount, 4)));
  const players: ShowFilePlayer[] = Array.isArray(raw.players)
    ? raw.players.filter((p: any) => p && typeof p === 'object').map((p: any, i: number) => ({
        performerId: nullableText(p.performerId),
        realName: text(p.realName).trim() || `Performer ${i + 1}`,
        characterName: text(p.characterName),
        notes: text(p.notes),
        assignedChannelKey: nullableText(p.assignedChannelKey),
        iemChannelKey: nullableText(p.iemChannelKey),
        sortIndex: whole(p.sortIndex, i),
        quickChanges: Array.isArray(p.quickChanges)
          ? p.quickChanges.filter((q: any) => q && typeof q === 'object').map((q: any, j: number) => ({
              act: q.act === null || q.act === undefined ? null : whole(q.act, 1),
              outCue: text(q.outCue),
              inCue: text(q.inCue),
              notes: text(q.notes),
              sortIndex: whole(q.sortIndex, j),
            }))
          : [],
      }))
    : [];

  const micCheck: ShowFileMicCheckEntry[] = Array.isArray(raw.micCheck)
    ? raw.micCheck
        .filter((e: any) => e && typeof e === 'object' && text(e.channelKey))
        // An entry for an act the show no longer has would be invisible and
        // undeletable, so it is dropped on the way in.
        .filter((e: any) => whole(e.act, 1) >= 1 && whole(e.act, 1) <= periodCount)
        .map((e: any) => ({
          act: whole(e.act, 1),
          channelKey: text(e.channelKey),
          checked: e.checked === true,
          checkedAt: nullableText(e.checkedAt),
          checkedBy: nullableText(e.checkedBy),
          notes: nullableText(e.notes),
        }))
    : [];

  // A duplicate (act, channelKey) would violate the unique index on the way in,
  // and the later entry is the better guess at current.
  const seen = new Map<string, ShowFileMicCheckEntry>();
  for (const entry of micCheck) seen.set(`${entry.act}|${entry.channelKey}`, entry);

  return {
    showFile: SHOW_FILE_VERSION,
    exportedAt: nullableText(raw.exportedAt) ?? new Date().toISOString(),
    show: {
      name: text(show.name).trim(),
      environmentMode: text(show.environmentMode, 'THEATER'),
      date: nullableText(show.date),
      venue: nullableText(show.venue),
      notes: nullableText(show.notes),
      periodCount,
      currentAct: Math.min(periodCount, Math.max(1, whole(show.currentAct, 1))),
    },
    players,
    micCheck: [...seen.values()].sort((a, b) => a.act - b.act || a.channelKey.localeCompare(b.channelKey)),
  };
}
