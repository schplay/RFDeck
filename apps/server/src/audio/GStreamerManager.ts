import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export class GStreamerManager extends EventEmitter {
  private process: ChildProcess | null = null;
  public isAvailable: boolean = false;

  constructor() {
    super();
    this.checkAvailability();
  }

  private checkAvailability() {
    try {
      const check = spawn('gst-launch-1.0', ['--version'], { shell: process.platform === 'win32' });
      
      check.on('error', () => {
        console.warn('[GStreamerManager] GStreamer (gst-launch-1.0) is not in PATH. Audio routing will be disabled.');
        this.isAvailable = false;
      });
      
      check.on('close', (code) => {
        if (code === 0) {
          this.isAvailable = true;
          console.log('[GStreamerManager] GStreamer found. Audio routing is enabled.');
        } else {
          console.warn('[GStreamerManager] GStreamer check failed with code', code);
          this.isAvailable = false;
        }
      });
    } catch (e) {
      console.warn('[GStreamerManager] Error checking GStreamer:', e);
      this.isAvailable = false;
    }
  }

  public startAES67Stream(multicastIp: string, port: number) {
    if (!this.isAvailable) {
      console.error('[GStreamerManager] Cannot start stream: GStreamer not installed.');
      return;
    }
    this.stop();

    const pipeline = [
      'udpsrc', `multicast-group=${multicastIp}`, `port=${port}`,
      '!', 'application/x-rtp,media=audio,clock-rate=48000,encoding-name=L24,channels=2',
      '!', 'rtpL24depay',
      '!', 'audioconvert',
      '!', 'audioresample',
      // The webrtcsink handles encoding to Opus and ICE negotiation
      '!', 'webrtcsink', 'signaller::uri=ws://localhost:3000/webrtc'
    ];

    console.log(`[GStreamerManager] Starting AES-67 pipeline: gst-launch-1.0 ${pipeline.join(' ')}`);
    this.process = spawn('gst-launch-1.0', pipeline, { shell: process.platform === 'win32' });

    this.process.stdout?.on('data', (data) => console.log(`[GST] ${data}`));
    this.process.stderr?.on('data', (data) => console.error(`[GST ERR] ${data}`));
  }

  public startTestTone() {
    if (!this.isAvailable) {
      console.error('[GStreamerManager] Cannot start stream: GStreamer not installed.');
      return;
    }
    this.stop();

    const pipeline = [
      'audiotestsrc', 'freq=440', 'volume=0.2',
      '!', 'audioconvert',
      '!', 'audioresample',
      '!', 'webrtcsink', 'signaller::uri=ws://localhost:3000/webrtc'
    ];

    console.log(`[GStreamerManager] Starting Test Tone pipeline...`);
    this.process = spawn('gst-launch-1.0', pipeline, { shell: process.platform === 'win32' });
    
    this.process.stderr?.on('data', (data) => console.error(`[GST ERR] ${data}`));
  }

  public stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
      console.log('[GStreamerManager] Pipeline stopped.');
    }
  }
}
