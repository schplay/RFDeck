export interface Show {
  id: string;
  name: string;
  environmentMode: 'THEATER' | 'CONCERT' | 'CORPORATE' | 'BROADCAST' | 'HOUSE_OF_WORSHIP';
  date?: string;
  venue?: string;
  notes?: string;
  players: Player[];
  micCheck: ShowMicCheck;
  createdAt: string;
  updatedAt: string;
}

export interface Player {
  id: string;
  showId: string;
  realName: string;
  characterName: string;
  notes: string;
  assignedChannelId: string | null;
}

export type MicCheckAct = 1 | 2 | 3 | 4;

export interface ShowMicCheck {
  currentAct: MicCheckAct;
  acts: Partial<Record<MicCheckAct, Record<string, ChannelCheckEntry>>>;
}

export interface ChannelCheckEntry {
  checked: boolean;
  checkedAt?: string;
  notes?: string;
}
