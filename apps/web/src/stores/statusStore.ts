import { create } from 'zustand';

// Facts about what RFDeck is doing right now, for the status bar.
//
// Each of these already existed somewhere — in a component's local state, in a
// server log, in a page an operator has to navigate to. That is fine for a
// setting and wrong for a fact that changes underneath you mid-show: whether
// audio is being kept, which channel is in your ears, how much of the rig is
// actually reporting. Held here so the shell can state them continuously
// instead of each page answering a different part of the question.

interface StatusStore {
  /** Rolling capture is armed — recording follows the patch and the live flag. */
  recordingEnabled: boolean;
  /** How many channels are actually being captured. */
  recordingChannels: number;
  applyRecording: (s: { enabled: boolean; channels: number }) => void;

  /**
   * The channels on the listen bus, by stable channel id.
   *
   * Shared so the shell can say what is in the operator's ears from anywhere,
   * and so every card, the menu and the status bar agree about it. Server-
   * confirmed: this is what the server said it put on the bus, which can be
   * fewer than were asked for.
   */
  listening: string[];
  setListening: (channelIds: string[]) => void;

  /**
   * Level per bus member, measured from the audio itself on the server.
   *
   * The first point in RFDeck where a level comes from audio rather than from a
   * number a receiver reported. Only for channels being listened to — the mix
   * has their samples and nothing else's.
   */
  audioLevels: Record<string, { peak: number; rms: number }>;
  applyAudioLevels: (levels: Record<string, { peak: number; rms: number }>) => void;

  /** Captures the operator asked for, in progress. Server-owned. */
  captures: ActiveCapture[];
  applyCaptures: (captures: ActiveCapture[]) => void;
}

export interface ActiveCapture {
  detectionId: string;
  channelKey: string;
  startedAt: number;
  endsAt: number;
}

export const useStatusStore = create<StatusStore>()((set) => ({
  recordingEnabled: false,
  recordingChannels: 0,
  applyRecording: ({ enabled, channels }) =>
    set({ recordingEnabled: enabled, recordingChannels: channels }),

  listening: [],
  setListening: (listening) => set(s => ({
    listening,
    // Levels for anything no longer on the bus are stale the moment it leaves.
    audioLevels: Object.fromEntries(Object.entries(s.audioLevels).filter(([k]) => listening.includes(k))),
  })),

  audioLevels: {},
  applyAudioLevels: (audioLevels) => set({ audioLevels }),

  captures: [],
  applyCaptures: (captures) => set({ captures }),
}));
