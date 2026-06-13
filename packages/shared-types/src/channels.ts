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
  gain?: number;
  status: 'ACTIVE' | 'WARNING' | 'CRITICAL';
}

