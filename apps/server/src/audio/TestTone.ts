import { nonstandard } from '@roamhq/wrtc';
import { log } from '../logger';

const { RTCAudioSource } = nonstandard;

const SAMPLE_RATE = 48000;
const CHANNEL_COUNT = 2;
const FRAMES_PER_CHUNK = SAMPLE_RATE / 100; // 480 frames = 10ms at 48 kHz

// The test tone behind the header monitor's play button: a 440 Hz sine on the
// listen path, so an operator can confirm that audio reaches their device
// before relying on it for a channel.
//
// Real channel audio does not come through here. It is captured by
// CaptureManager and mixed per listener by Mixer; AES67 streams arrive through
// the aes67-linux-daemon.
export class TestTone {
  public readonly audioSource: nonstandard.RTCAudioSource;
  private interval: ReturnType<typeof setInterval> | null = null;
  private phase = 0;

  constructor() {
    this.audioSource = new RTCAudioSource();
  }

  start(): void {
    this.stop();
    this.phase = 0;

    this.interval = setInterval(() => {
      const samples = new Int16Array(FRAMES_PER_CHUNK * CHANNEL_COUNT);
      for (let i = 0; i < FRAMES_PER_CHUNK; i++) {
        const s = Math.round(Math.sin(this.phase) * 0.2 * 32767);
        samples[i * 2] = s;
        samples[i * 2 + 1] = s;
        this.phase += (2 * Math.PI * 440) / SAMPLE_RATE;
      }
      this.audioSource.onData({
        samples,
        sampleRate: SAMPLE_RATE,
        bitsPerSample: 16,
        channelCount: CHANNEL_COUNT,
        numberOfFrames: FRAMES_PER_CHUNK,
      });
    }, 10);

    log.debug('[TestTone] Started (440 Hz).');
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
