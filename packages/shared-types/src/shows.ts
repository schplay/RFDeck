export interface Show {
  id: string;
  name: string;
  environmentMode: 'THEATER' | 'CONCERT' | 'CORPORATE' | 'BROADCAST' | 'HOUSE_OF_WORSHIP';
  date?: string;
  venue?: string;
  notes?: string;
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
  /** Channel NAME, not channel id — see apps/web/src/lib/channelKey.ts.
   *  Channel ids embed the device IP and break on DHCP reassignment. */
  assignedChannelKey: string | null;
}

export type MicCheckAct = 1 | 2 | 3 | 4;

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
