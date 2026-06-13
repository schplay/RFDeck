export type AlertSeverity = 'CRITICAL' | 'WARNING' | 'INFO';
export type AlertType =
  | 'DROPOUT'
  | 'LOW_BATTERY'
  | 'CRITICAL_BATTERY'
  | 'TX_OFF'
  | 'MUTED'
  | 'DEVICE_LOST'
  | 'DEVICE_FOUND'
  | 'LOW_RF'
  | 'CLIPPING';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  type: AlertType;
  message: string;
  detail?: string; // optional extra context
  timestamp: string; // ISO string (Date serializes cleanly over socket)
  deviceId?: string;
  channelId?: string;
  channelName?: string;
  deviceName?: string;
  acknowledged: boolean;
  dismissed: boolean;
}
