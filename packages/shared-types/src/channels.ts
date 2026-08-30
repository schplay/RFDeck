export interface Channel {
  id: string;
  deviceId: string;
  channelIndex: number;
  name: string;
  frequency: number;
  rfLevelA: number;
  rfLevelB: number;
  afLevel: number;
  batteryPercent?: number;
  isMuted: boolean;
  /** Muted at the transmitter (the performer's switch), as distinct from a
   *  receiver-side mute. Deliberate, so views show it as a mute — not a
   *  warning, which read as a fault for a mic that was simply switched off. */
  isTxMuted?: boolean;
  gain?: number;
  status: 'ACTIVE' | 'WARNING' | 'CRITICAL';
}

