import * as dgram from 'dgram';
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { nonstandard } from '@roamhq/wrtc';
import { log } from '../logger';

const { RTCAudioSource } = nonstandard;

const SAMPLE_RATE = 48000;
const CHANNEL_COUNT = 2;
const FRAMES_PER_CHUNK = SAMPLE_RATE / 100; // 480 frames = 10ms at 48 kHz

export class AES67Manager extends EventEmitter {
  public readonly audioSource: nonstandard.RTCAudioSource;
  private captureProc: ChildProcess | null = null;
  private captureChannels = CHANNEL_COUNT;
  public readonly isAvailable = true;

  private udpSocket: dgram.Socket | null = null;
  private testToneInterval: ReturnType<typeof setInterval> | null = null;
  private sampleBuffer = new Int16Array(FRAMES_PER_CHUNK * CHANNEL_COUNT);
  private bufferOffset = 0;
  private testTonePhase = 0;

  constructor() {
    super();
    this.audioSource = new RTCAudioSource();
    log.debug('[AES67Manager] Ready (no external dependencies required).');
  }

  startAES67Stream(multicastIp: string, port: number): void {
    this.stop();
    this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.udpSocket.on('message', (msg) => this.handleRTPPacket(msg));
    this.udpSocket.on('error', (err) => {
      log.error('[AES67Manager] UDP socket error:', err);
    });

    this.udpSocket.bind(port, () => {
      this.udpSocket!.addMembership(multicastIp);
      log.debug(`[AES67Manager] Joined AES-67 multicast ${multicastIp}:${port}`);
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


  // ── Local capture ──────────────────────────────────────────────────────────
  //
  // Capture from an audio interface attached to this machine and feed it into
  // the same WebRTC source the AES67 path uses, so remote clients hear the rack
  // rather than their own laptop microphone.
  //
  // Uses `arecord` rather than a native binding: it ships with alsa-utils
  // (already a dependency of the AES67 daemon), needs no compilation, and
  // survives Node upgrades. The cost is one extra process, which is nothing
  // beside the WebRTC encoder.

  startLocalCapture(deviceId: string, channels = CHANNEL_COUNT): void {
    this.stop();

    const args = [
      '-D', deviceId,
      '-f', 'S16_LE',              // matches what RTCAudioSource expects
      '-r', String(SAMPLE_RATE),
      '-c', String(channels),
      '-t', 'raw',
      '--buffer-size=8192',        // small enough to keep monitoring latency low
      '-q',
    ];

    log.info(`[AES67Manager] Capturing from ${deviceId} (${channels}ch)`);
    const proc = spawn('arecord', args);
    this.captureProc = proc;
    this.captureChannels = channels;

    proc.stdout.on('data', (chunk: Buffer) => this.handlePcmChunk(chunk));

    proc.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) log.warn(`[arecord] ${msg}`);
    });

    proc.on('error', (err: Error) => {
      log.error(`[AES67Manager] Could not start arecord: ${err.message}`);
      this.captureProc = null;
    });

    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // A non-zero exit while we still expect to be capturing means the device
      // went away or is held by something else — worth saying, not worth
      // crashing the server over.
      if (this.captureProc === proc && code !== 0 && signal !== 'SIGTERM') {
        log.error(`[AES67Manager] Capture from ${deviceId} stopped (exit ${code})`);
      }
      if (this.captureProc === proc) this.captureProc = null;
    });
  }

  // arecord delivers arbitrary-sized chunks; RTCAudioSource wants fixed frames.
  private handlePcmChunk(chunk: Buffer): void {
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      this.sampleBuffer[this.bufferOffset++] = chunk.readInt16LE(i);

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

    log.debug('[AES67Manager] Test tone started (440 Hz).');
  }

  stop(): void {
    if (this.captureProc) {
      this.captureProc.kill('SIGTERM');
      this.captureProc = null;
    }
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
