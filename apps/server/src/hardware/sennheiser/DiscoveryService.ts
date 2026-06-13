import Bonjour from 'bonjour-service';
import { EventEmitter } from 'events';

export interface DiscoveredDevice {
  ip: string;
  port: number;
  name: string;
  protocol: 'ssc' | 'sennheiser-ssc' | string;
}

export class DiscoveryService extends EventEmitter {
  private bonjour = new Bonjour();

  constructor() {
    super();
  }

  start() {
    console.log('[Discovery] Starting mDNS discovery for Sennheiser devices...');

    // EW-DX and newer usually broadcast _ssc._tcp
    this.bonjour.find({ type: 'ssc' }, (service: any) => {
      const ip = service.addresses?.[0] || service.host;
      if (ip) {
        this.emit('discovered', {
          ip,
          port: service.port,
          name: service.name,
          protocol: 'ssc'
        } as DiscoveredDevice);
      }
    });

    // Older ones or specific models might use a different type
    this.bonjour.find({ type: 'sennheiser-ssc' }, (service: any) => {
      const ip = service.addresses?.[0] || service.host;
      if (ip) {
        this.emit('discovered', {
          ip,
          port: service.port,
          name: service.name,
          protocol: 'sennheiser-ssc'
        } as DiscoveredDevice);
      }
    });
  }

  stop() {
    this.bonjour.destroy();
  }
}
