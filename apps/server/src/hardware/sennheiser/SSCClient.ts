import axios, { AxiosInstance } from 'axios';
import https from 'https';
import { EventEmitter } from 'events';

export class SSCClient extends EventEmitter {
  public ip: string;
  public port: number;
  private client: AxiosInstance;
  private interval: NodeJS.Timeout | null = null;
  public isConnected: boolean = false;

  constructor(ip: string, port: number) {
    super();
    this.ip = ip;
    this.port = port;

    // EW-DX uses HTTPS, older might use HTTP. We allow self-signed certs.
    this.client = axios.create({
      timeout: 2000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
  }

  startPolling(intervalMs: number = 250) {
    if (this.interval) return;
    this.interval = setInterval(() => this.poll(), intervalMs);
  }

  stopPolling() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isConnected = false;
  }

  private async poll() {
    try {
      // SSCv2 API: Try fetching the full state tree.
      // Often available at /osc/ or /ssc/ or even /. We will try /osc/ first.
      const url = `https://${this.ip}/osc/`; // Adjust based on exact hardware behavior
      const response = await this.client.get(url);
      
      if (!this.isConnected) {
        this.isConnected = true;
        this.emit('connected');
      }

      this.emit('state', response.data);
    } catch (err: any) {
      // If HTTPS fails, try HTTP or a different endpoint later, but for now just handle errors
      if (this.isConnected) {
        this.isConnected = false;
        this.emit('disconnected', err.message);
      }
    }
  }

  // Generic write operation (e.g. path = 'rx1/mute', value = true)
  async sendControl(path: string, value: any): Promise<boolean> {
    try {
      // Clean up path leading slash if present
      const cleanPath = path.startsWith('/') ? path.slice(1) : path;
      const url = `https://${this.ip}/osc/${cleanPath}`;
      // In Sennheiser SSC, writes are often PUT or PATCH depending on the specific implementation,
      // but commonly it's a PATCH or PUT with { "value": <data> } or directly the tree.
      // Often SSC is a single JSON tree, so a PATCH to the root is used, or PUT to the specific leaf.
      // Let's use PUT to the specific leaf node which is common for OSC-like JSON endpoints.
      await this.client.put(url, { value });
      return true;
    } catch (err: any) {
      console.error(`[SSCClient] Failed to send control ${path} to ${this.ip}:`, err.message);
      return false;
    }
  }

  // Dedicated identify helper (LED flash)
  async identify(): Promise<boolean> {
    // Exact path depends on hardware, commonly 'device/identity/flash' or similar
    return this.sendControl('device/identity/flash', true);
  }

  // Dedicated mute helper
  async setMute(rxIndex: number, muted: boolean): Promise<boolean> {
    return this.sendControl(`rx${rxIndex}/mute`, muted);
  }

  // Set receiver gain
  async setGain(rxIndex: number, gain: number): Promise<boolean> {
    return this.sendControl(`rx${rxIndex}/audio/gain`, gain);
  }

  // Set frequency (in Hz)
  async setFrequency(rxIndex: number, frequencyHz: number): Promise<boolean> {
    return this.sendControl(`rx${rxIndex}/frequency`, frequencyHz);
  }

  // Network configuration
  async setNetwork(staticIp: string, subnet: string, gateway: string): Promise<boolean> {
    // Requires patching multiple endpoints usually, or sending a partial tree to /network
    try {
      await this.sendControl('network/ip', staticIp);
      await this.sendControl('network/subnet', subnet);
      await this.sendControl('network/gateway', gateway);
      // Depending on the model, it might require a 'network/apply' or reboot
      return true;
    } catch {
      return false;
    }
  }
}


