import { AES67DaemonClient, DaemonSink, RemoteSource } from './AES67DaemonClient';
import { log } from '../logger';

// Subscribes the server to AES67 senders, so the operator never has to open the
// daemon's own web UI.
//
// The daemon receives a stream only if a "sink" exists for it, and each sink
// occupies a block of channels on the RAVENNA ALSA device. Those blocks must not
// overlap: two sinks writing the same channel produce audio that alternates
// between two sources, which sounds like a fault in the receiver rather than a
// configuration mistake. So allocation is central here rather than left to
// whoever creates a sink.
//
// Channel numbering note: the daemon's `map` is 0-based ALSA channel indices,
// while RFDeck's audio patch is 1-based ("input 1" is what an operator says).
// The conversion happens at the boundary in the routes layer, not here.

/** How many channels the RAVENNA device exposes. Probed, never assumed. */
export interface Allocation {
  sinkId: number;
  /** 0-based ALSA channels this sink writes. */
  channels: number[];
}

export interface ProvisionResult {
  created: boolean;
  sinkId: number;
  channels: number[];
  /** 1-based, for display and for patching. */
  inputChannels: number[];
  name: string;
}

export class SinkManager {
  constructor(private readonly daemon = new AES67DaemonClient()) {}

  get client(): AES67DaemonClient {
    return this.daemon;
  }

  // How many channels does this sender carry? Read from its SDP rather than
  // assumed to be stereo — an AES67 flow may be 1, 2, 8, 16 or more channels,
  // and guessing wrong either wastes channels or truncates the stream.
  //
  // SDP media line: "m=audio 5004 RTP/AVP 98"
  // Format line:    "a=rtpmap:98 L24/48000/8"  <- trailing field is the count
  static channelCountFromSdp(sdp: string): number | null {
    const rtpmap = sdp.match(/^a=rtpmap:\d+\s+L\d+\/\d+(?:\/(\d+))?/m);
    if (rtpmap) {
      // A missing trailing field means one channel, per RFC 4566.
      return rtpmap[1] ? Number(rtpmap[1]) : 1;
    }
    return null;
  }

  static sourceName(source: RemoteSource): string {
    const sessionName = source.sdp?.match(/^s=(.*)$/m)?.[1]?.trim();
    return source.name || sessionName || `AES67 ${source.id}`;
  }

  // The daemon refuses a sink whose name is already taken (stream_name_in_use),
  // and two identical units announce identical session names — so the second
  // of a matched pair would fail for no reason an operator could see.
  static uniqueName(base: string, sinks: DaemonSink[]): string {
    const taken = new Set(sinks.map(s => s.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  // Which sender is a sink currently receiving? Matched on the SDP Originator
  // (o=), which is what the daemon itself uses to pair the two — so a sender
  // that changes address is still recognised as the same one.
  private static originator(sdp: string | undefined): string | null {
    return sdp?.match(/^o=(.*)$/m)?.[1]?.trim() ?? null;
  }

  static isSubscribedTo(sink: DaemonSink, source: RemoteSource): boolean {
    const a = SinkManager.originator(sink.sdp);
    const b = SinkManager.originator(source.sdp);
    return !!a && !!b && a === b;
  }

  // Lowest free block of `count` contiguous channels.
  //
  // Contiguous so a multichannel sender lands on adjacent inputs, which is what
  // an operator expects when patching "the first eight" of a stagebox.
  static allocate(taken: Set<number>, count: number, deviceChannels: number): number[] | null {
    for (let start = 0; start + count <= deviceChannels; start++) {
      let free = true;
      for (let i = 0; i < count; i++) {
        if (taken.has(start + i)) { free = false; break; }
      }
      if (free) return Array.from({ length: count }, (_, i) => start + i);
    }
    return null;
  }

  private static takenChannels(sinks: DaemonSink[]): Set<number> {
    const taken = new Set<number>();
    for (const s of sinks) for (const ch of s.map ?? []) taken.add(ch);
    return taken;
  }

  private static nextSinkId(sinks: DaemonSink[]): number {
    const used = new Set(sinks.map(s => s.id));
    for (let id = 0; id < 64; id++) if (!used.has(id)) return id;
    throw new Error('No free sink slot on the AES67 daemon (64 in use)');
  }

  /**
   * Receive this sender, if we are not already.
   *
   * Idempotent: called twice for the same sender it returns the existing sink
   * rather than creating a duplicate that would fight it for channels.
   */
  async provision(source: RemoteSource, deviceChannels: number): Promise<ProvisionResult> {
    const sinks = await this.daemon.listSinks();

    const existing = sinks.find(s => SinkManager.isSubscribedTo(s, source));
    if (existing) {
      return {
        created: false,
        sinkId: existing.id,
        channels: existing.map ?? [],
        inputChannels: (existing.map ?? []).map(c => c + 1),
        name: existing.name,
      };
    }

    const count = SinkManager.channelCountFromSdp(source.sdp);
    if (count === null) {
      throw new Error(
        `Could not read the channel count from this sender's SDP, so RFDeck ` +
        `cannot tell how many inputs to reserve for it.`,
      );
    }

    const channels = SinkManager.allocate(
      SinkManager.takenChannels(sinks), count, deviceChannels,
    );
    if (!channels) {
      throw new Error(
        `No free block of ${count} channels on the audio device ` +
        `(${deviceChannels} total). Remove an unused subscription first.`,
      );
    }

    const id = SinkManager.nextSinkId(sinks);
    const name = SinkManager.uniqueName(SinkManager.sourceName(source), sinks);

    await this.daemon.createSink(id, {
      name,
      io: 'Audio Device',
      // Subscribe from the SDP we already have, rather than having the daemon
      // re-fetch it over RTSP — one less thing to fail on a locked-down network.
      use_sdp: true,
      sdp: source.sdp,
      // Ignored when use_sdp is true, but the daemon's parser still demands the
      // key be present: omitting it is a 400, not a default.
      source: '',
      delay: 576,
      ignore_refclk_gmid: false,
      map: channels,
    });

    return {
      created: true,
      sinkId: id,
      channels,
      inputChannels: channels.map(c => c + 1),
      name,
    };
  }

  async unprovision(sinkId: number): Promise<void> {
    await this.daemon.deleteSink(sinkId);
  }

  /**
   * Subscribe to every discovered sender that is not already subscribed.
   *
   * Deliberately not automatic on a timer: silently claiming channels as
   * senders appear would reshuffle an operator's patch mid-show. This runs only
   * when asked.
   */
  async provisionAll(deviceChannels: number): Promise<{
    provisioned: ProvisionResult[];
    failed: Array<{ name: string; error: string }>;
  }> {
    const sources = await this.daemon.browseSources('all');
    const provisioned: ProvisionResult[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    for (const source of sources) {
      try {
        const result = await this.provision(source, deviceChannels);
        if (result.created) provisioned.push(result);
      } catch (err: any) {
        const name = SinkManager.sourceName(source);
        failed.push({ name, error: err?.message ?? 'Unknown error' });
        log.warn(`[aes67] Could not subscribe to "${name}": ${err?.message}`);
      }
    }

    return { provisioned, failed };
  }
}
