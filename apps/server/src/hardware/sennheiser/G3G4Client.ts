import net from 'net';
import dgram from 'dgram';
import { EventEmitter } from 'events';

// Basic wrapper for G3/G4 using either TCP port 328/3601 or UDP 58163
export class G3G4Client extends EventEmitter {
  public ip: string;
  public port: number;
  public isConnected: boolean = false;
  private interval: NodeJS.Timeout | null = null;
  
  // For simplicity we'll just mock a TCP socket connection for now
  private socket: net.Socket | null = null;

  constructor(ip: string, port: number) {
    super();
    this.ip = ip;
    // Default to TCP 328 if standard HTTPS port was passed, else use what's passed
    this.port = port === 443 || port === 80 ? 328 : port;
  }

  startPolling(intervalMs: number = 500) {
    if (this.interval) return;

    // Simulate connecting
    this.socket = new net.Socket();
    this.socket.on('error', (err) => {
      if (this.isConnected) {
        this.isConnected = false;
        this.emit('disconnected', err.message);
      }
    });

    this.socket.on('data', (data) => {
      // Parse raw SSCv1 text (e.g. `rx1 rf_quality 80\nrx1 af_level -10`)
      // Convert to a tree like SSCv2 so DeviceManager can normalize it easily
      // Mocking for now to prove out the architecture
    });

    this.socket.connect(this.port, this.ip, () => {
      this.isConnected = true;
      this.emit('connected');
      
      this.interval = setInterval(() => {
        // Mocking polling state:
        const mockStateTree = {
          rx1: {
            name: "G3/G4 Legacy",
            frequency: 512000,
            rf_quality: Math.floor(Math.random() * 20) + 80,
            af_level: -20,
            mute: false,
            battery: { percent: 100 }
          }
        };
        this.emit('state', mockStateTree);
      }, intervalMs);
    });
  }

  stopPolling() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.isConnected = false;
  }

  async sendControl(path: string, value: any): Promise<boolean> {
    if (!this.isConnected || !this.socket) return false;
    // Send SSCv1 command e.g. `rx1 mute 1\r`
    const sscPath = path.replace('/', ' ');
    const cmd = `${sscPath} ${value === true ? 1 : value === false ? 0 : value}\r`;
    this.socket.write(cmd);
    return true;
  }

  async identify(): Promise<boolean> {
    return this.sendControl('device ident', true);
  }

  async setMute(rxIndex: number, muted: boolean): Promise<boolean> {
    return this.sendControl(`rx${rxIndex} mute`, muted);
  }
}
