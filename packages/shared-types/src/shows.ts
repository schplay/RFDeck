export interface Show {
  id: string;
  name: string;
  environmentMode: 'THEATER' | 'CONCERT' | 'CORPORATE' | 'BROADCAST' | 'HOUSE_OF_WORSHIP';
  date?: string;
  venue?: string;
  notes?: string;
  slots: ShowSlot[];
  createdAt: string;
  updatedAt: string;
}

export interface ShowSlot {
  id: string;
  showId: string;
  name: string;           // e.g. "Act 1 – Opening Number"
  order: number;
  assignedChannelIds: string[];  // Channel IDs from inventory/live channels
  micCheckStatus: 'PENDING' | 'CHECKED' | 'ISSUE' | 'SKIPPED';
  micCheckNotes?: string;
  micCheckTimestamp?: string;
}

export type MicCheckStatus = ShowSlot['micCheckStatus'];
