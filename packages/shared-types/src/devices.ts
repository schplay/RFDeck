export interface Device {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  ipAddress?: string;
  status: 'ONLINE' | 'OFFLINE' | 'UNREACHABLE';
}
