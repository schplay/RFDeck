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
  /**
   * What this channel is for.
   *
   * A receiver carries a microphone; an IEM transmitter carries a monitor
   * feed. They are both channels and neither is interchangeable with the
   * other: an IEM has no RF to receive and no transmitter battery to report,
   * so treating one as a mic means a channel permanently at 0% RF raising
   * dropout alerts for a device that is working perfectly.
   *
   * Server-authoritative, from the inventory row's `deviceType`. Clients used
   * to infer this by matching channel ids against inventory IPs, which meant
   * every client reimplementing it and the server — where the alerting lives —
   * never knowing at all.
   */
  role: 'mic' | 'iem';
  status: 'ACTIVE' | 'WARNING' | 'CRITICAL';
}

