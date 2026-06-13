import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import { nonstandard } from '@roamhq/wrtc';

const { RTCAudioSource } = nonstandard;

const SAMPLE_RATE = 48000;
const CHANNEL_COUNT = 2;
const FRAMES_PER_CHUNK = SAMPLE_RATE / 100; // 480 frames = 10ms at 48 kHz

export class AES67Manager extends EventEmitter {
  public readonly audioSource: nonstandard.RTCAudioSource;
  public readonly isAvailable = true;

  private udpSocket: dgram.Socket | null = null;
  private testToneInterval: ReturnType<typeof setInterval> | null = null;
  private sampleBuffer = new Int16Array(FRAMES_PER_CHUNK * CHANNEL_COUNT);
  private bufferOffset = 0;
  private testTonePhase = 0;

  constructor() {
    super();
    this.audioSource = new RTCAudioSource();
    console.log('[AES67Manager] Ready (no external dependencies required).');
  }

  startAES67Stream(multicastIp: string, port: number): void {
    this.stop();
    this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.udpSocket.on('message', (msg) => this.handleRTPPacket(msg));
    this.udpSocket.on('error', (err) => {
      console.error('[AES67Manager] UDP socket error:', err);
    });

    this.udpSocket.bind(port, () => {
      this.udpSocket!.addMembership(multicastIp);
      console.log(`[AES67Manager] Joined AES-67 multicast ${multicastIp}:${port}`);
    });
  }

  private handleRTPPacket(packet: Buffer): void {
    if (packet.length < 12) return;

    const firstByte = packet[0];
    if ((firstByte >> 6) !== 2) return; // RTP version must be 2

    // Skip past the fixed header, any CSRCs, and any extension header
    const csrcCount = firstByte & 0x0f;
    const hasExtension = (firstByte >> 4) & 0x1;
    let headerSize = 12 + csrcCount * 4;
    if (hasExtension && packet.length >= headerSize + 4) {
      const extLen = packet.readUInt16BE(headerSize + 2);
      headerSize += 4 + extLen * 4;
    }

    const payload = packet.subarray(headerSize);
    if (payload.length < 3) return;

    // L24: 24-bit signed big-endian PCM, 3 bytes per sample (interleaved stereo)
    // Convert to 16-bit by reading the top 16 bits of each sample.
    const sampleCount = Math.floor(payload.length / 3);
    for (let i = 0; i < sampleCount; i++) {
      let s24 = (payload[i * 3] << 16) | (payload[i * 3 + 1] << 8) | payload[i * 3 + 2];
      if (s24 >= 0x800000) s24 -= 0x1000000; // sign-extend to JS number
      this.sampleBuffer[this.bufferOffset++] = s24 >> 8;

      if (this.bufferOffset >= this.sampleBuffer.length) {
        this.audioSource.onData({
          samples: this.sampleBuffer,
          sampleRate: SAMPLE_RATE,
          bitsPerSample: 16,
          channelCount: CHANNEL_COUNT,
          numberOfFrames: FRAMES_PER_CHUNK,
        });
        this.bufferOffset = 0;
      }
    }
  }

  startTestTone(): void {
    this.stop();
    this.testTonePhase = 0;

    this.testToneInterval = setInterval(() => {
      const samples = new Int16Array(FRAMES_PER_CHUNK * CHANNEL_COUNT);
      for (let i = 0; i < FRAMES_PER_CHUNK; i++) {
        const s = Math.round(Math.sin(this.testTonePhase) * 0.2 * 32767);
        samples[i * 2] = s;
        samples[i * 2 + 1] = s;
        this.testTonePhase += (2 * Math.PI * 440) / SAMPLE_RATE;
      }
      this.audioSource.onData({
        samples,
        sampleRate: SAMPLE_RATE,
        bitsPerSample: 16,
        channelCount: CHANNEL_COUNT,
        numberOfFrames: FRAMES_PER_CHUNK,
      });
    }, 10);

    console.log('[AES67Manager] Test tone started (440 Hz).');
  }

  stop(): void {
    if (this.udpSocket) {
      this.udpSocket.close();
      this.udpSocket = null;
    }
    if (this.testToneInterval) {
      clearInterval(this.testToneInterval);
      this.testToneInterval = null;
    }
    this.bufferOffset = 0;
  }
}
