import { QuickChange } from './environments';

export interface Show {
  id: string;
  name: string;
  environmentMode: 'THEATER' | 'CONCERT' | 'CORPORATE' | 'BROADCAST' | 'HOUSE_OF_WORSHIP';
  date?: string;
  venue?: string;
  notes?: string;
  /**
   * How many acts, services, sets or segments this production runs to.
   *
   * Was fixed at four everywhere, which is a theatre assumption: a worship
   * service is usually one, a festival set list is however many bands are
   * booked. The mic check is per period, so a wrong count is either tabs that
   * can never be filled in or periods that cannot be checked at all.
   */
  periodCount: number;
  /** Archived shows stay in the database and remain readable; they are just
   *  filtered out of the default list. Shows may equally live indefinitely. */
  archived: boolean;
  archivedAt?: string;
  players: Player[];
  micCheck: ShowMicCheck;
  createdAt: string;
  updatedAt: string;
}

export interface Player {
  id: string;
  showId: string;
  /** The roster entry this casting refers to. Null only for legacy rows that
   *  predate the roster and could not be matched to a performer. */
  performerId: string | null;
  /** The performer's name, copied onto the casting. Kept in step by the
   *  server when the performer is renamed. */
  realName: string;
  characterName: string;
  notes: string;
  /** Stable channel id — see apps/web/src/lib/channelKey.ts. Survives a DHCP
   *  reassignment and a rename of the channel on the hardware. */
  assignedChannelKey: string | null;
  /** The performer's IEM channel, by stable id, on the same terms as the mic.
   *  Assigned here; never part of the soundcheck, which is about mics only. */
  iemChannelKey: string | null;
  /** Costume changes that take the pack off, for this show. */
  quickChanges: QuickChange[];
}

/**
 * Which act, service or set. One-based.
 *
 * A plain number rather than a fixed union: the count is a property of the
 * production, not of RFDeck, and it was 1 | 2 | 3 | 4 only because the UI
 * happened to render four buttons.
 */
export type MicCheckAct = number;

export interface ShowMicCheck {
  currentAct: MicCheckAct;
  /** act -> channelKey -> entry */
  acts: Partial<Record<MicCheckAct, Record<string, ChannelCheckEntry>>>;
}

export interface ChannelCheckEntry {
  checked: boolean;
  checkedAt?: string;
  /** Operator who performed the check, once identity is available. */
  checkedBy?: string;
  notes?: string;
}
