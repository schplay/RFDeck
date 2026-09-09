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
   * The channel currently being monitored, by stable channel id.
   *
   * Lifted out of useChannelAudio's local state so the shell can say what is in
   * the operator's ears from anywhere — and so that more than one channel can
   * be listened to at once later without moving it a second time.
   */
  listeningTo: string | null;
  setListeningTo: (channelId: string | null) => void;
}

export const useStatusStore = create<StatusStore>()((set) => ({
  recordingEnabled: false,
  recordingChannels: 0,
  applyRecording: ({ enabled, channels }) =>
    set({ recordingEnabled: enabled, recordingChannels: channels }),

  listeningTo: null,
  setListeningTo: (listeningTo) => set({ listeningTo }),
}));
