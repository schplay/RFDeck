import { log } from '../logger';

// Talks to the AES67 daemon's REST API on this machine.
//
// The daemon receives network audio into the RAVENNA ALSA device that RFDeck
// captures from, but only for streams it has been told to subscribe to. Those
// subscriptions are "sinks", and the daemon does not create them on its own:
// SAP and mDNS advertise *senders*, and something has to decide which of them
// to receive. Upstream expects an operator to do that in the daemon's own web
// UI, which is a second interface on a second port that a rack server may not
// even be exposing — so RFDeck does it instead.
//
// Note the direction. A daemon "source" transmits and a "sink" receives; RFDeck
// wants audio arriving, so it works exclusively with sinks.
//
// API shape verified against the daemon's documented REST interface rather than
// assumed:
//   GET    /api/browse/sources/[all|mdns|sap]   remote senders discovered
//   GET    /api/sinks                           subscriptions we hold
//   PUT    /api/sink/:id                        create or update one
//   DELETE /api/sink/:id                        drop one
//   GET    /api/ptp/status                      clock lock state

export interface RemoteSource {
  /** How it was found — 'sap' or 'mdns'. */
  source: string;
  /** SDP session id; stable for a given sender. */
  id: string;
  name: string;
  domain?: string;
  address?: string;
  sdp: string;
  /** Seconds since last seen. Absent on some daemon versions. */
  last_seen?: number;
  announce_period?: number;
}

// Every field is required. The daemon parses each one with a throwing getter
// (json_to_sink in daemon/json.cpp: pt.get<T>("key")) and has no defaults, so
// an omitted key is an HTTP 400 — not a field quietly left at zero. The type
// says so, rather than marking fields optional and letting the daemon be the
// one to complain.
export interface DaemonSink {
  id: number;
  name: string;
  io: string;
  use_sdp: boolean;
  /** SDP URL fetched when use_sdp is false. Ignored, but still required, otherwise. */
  source: string;
  sdp: string;
  delay: number;
  ignore_refclk_gmid: boolean;
  /** ALSA capture channels this sink writes into. */
  map: number[];
}

export interface SinkStatus {
  sink_flags?: Record<string, boolean>;
  sink_min_time?: number;
  is_rtp_seq_id_error?: boolean;
  is_rtp_ssrc_error?: boolean;
  is_receiving_rtp_packet?: boolean;
}

export interface PtpStatus {
  status?: string;
  gmid?: string;
  jitter?: number;
}

export class AES67DaemonClient {
  constructor(
    private readonly baseUrl = process.env.AES67_DAEMON_URL ?? 'http://127.0.0.1:8080',
    private readonly timeoutMs = 4000,
  ) {}

  get url(): string {
    return this.baseUrl;
  }

  // Is the daemon installed and answering? Everything else is gated on this,
  // since a desktop install or a server built with --no-aes67 has no daemon at
  // all and that is a normal configuration, not a fault.
  async available(): Promise<boolean> {
    try {
      await this.request('GET', '/api/sinks');
      return true;
    } catch {
      return false;
    }
  }

  async browseSources(via: 'all' | 'sap' | 'mdns' = 'all'): Promise<RemoteSource[]> {
    const body = await this.request<any>('GET', `/api/browse/sources/${via}`);
    // Shape differs slightly across daemon versions: some return a bare array,
    // others wrap it. Accept both rather than depending on one.
    const list = Array.isArray(body) ? body : body?.remote_sources ?? body?.sources ?? [];
    return Array.isArray(list) ? list : [];
  }

  async listSinks(): Promise<DaemonSink[]> {
    const body = await this.request<any>('GET', '/api/sinks');
    const list = Array.isArray(body) ? body : body?.sinks ?? [];
    return Array.isArray(list) ? list : [];
  }

  async createSink(id: number, sink: Omit<DaemonSink, 'id'>): Promise<void> {
    await this.request('PUT', `/api/sink/${id}`, sink);
    log.info(`[aes67] Sink ${id} "${sink.name}" -> channels ${sink.map.join(',')}`);
  }

  async deleteSink(id: number): Promise<void> {
    await this.request('DELETE', `/api/sink/${id}`);
    log.info(`[aes67] Sink ${id} removed`);
  }

  async sinkStatus(id: number): Promise<SinkStatus | null> {
    try {
      return await this.request<SinkStatus>('GET', `/api/sink/status/${id}`);
    } catch {
      return null;
    }
  }

  async ptpStatus(): Promise<PtpStatus | null> {
    try {
      return await this.request<PtpStatus>('GET', '/api/ptp/status');
    } catch {
      return null;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    // The daemon is on loopback; a slow reply means it is wedged, and a live
    // show must not stall on it.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (!res.ok) {
        // The daemon puts the actual reason in the body — on a 400 it is the
        // parser's exception text, naming the missing or malformed field. A bare
        // status code hides exactly the information needed to fix the request.
        const detail = text.trim();
        throw new Error(
          `AES67 daemon ${method} ${path} returned ${res.status}` +
          (detail ? `: ${detail}` : ''),
        );
      }
      return (text ? JSON.parse(text) : undefined) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
