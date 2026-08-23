import axios, { AxiosInstance } from 'axios';
import https from 'https';
import dgram from 'dgram';
import { EventEmitter } from 'events';
import { log } from '../../logger';

// Endpoint candidates tried in order on first connection.
// SSCv2 (EW-DX firmware ≥ 4.0): HTTPS on port 443, REST at /api/ssc/version
// SSCv1 (older EW-DX / EW-D):    HTTP or HTTPS, legacy /osc/ path
// We probe both in order and cache the first working URL.
const PROBE_CANDIDATES = [
  { scheme: 'https', path: '/api/ssc/version' },
  { scheme: 'https', path: '/api/device/identity' },
  { scheme: 'https', path: '/osc/' },
  { scheme: 'http',  path: '/api/ssc/version' },
  { scheme: 'http',  path: '/osc/' },
] as const;

type Scheme = 'https' | 'http';

export class SSCClient extends EventEmitter {
  public ip: string;
  public port: number;
  private password: string | null;
  private httpsClient: AxiosInstance;
  private httpClient: AxiosInstance;
  private interval: NodeJS.Timeout | null = null;
  public isConnected: boolean = false;
  private polling = false;
  private failCount = 0;
  private disconnectSignaled = false;
  private activeUrl: string | null = null;
  private baseUrl: string | null = null;   // https://ip:port
  private isSSCv2 = false;                 // true when /api/ endpoints are working
  private metadataFetched = false;
  // When SSCv2 connects but /api/rx{n} consistently returns no data (404 or empty),
  // we fall back to /osc/ silently without triggering the G3/G4 fallback chain.
  private sscv2RxMissing = false;          // skip /api/* candidates on next probe
  private emptyPollCount = 0;             // consecutive SSCv2 polls with no rx data
  // SSCv2 SSE subscription state (per the Sennheiser 3rd-party API spec)
  private sseActive = false;              // SSE stream is open and delivering data

  // Liveness, as distinct from data.
  //
  // SSE pushes a value only when it changes, so a receiver whose mic is on but
  // nobody is speaking into produces no traffic at all — indistinguishable, from
  // the outside, from a stream that has silently died. Contact is therefore
  // tracked separately from telemetry: every byte on the SSE socket counts, and
  // when it has been quiet for a while the device is asked directly.
  private lastActivity = 0;
  private lastAliveEmit = 0;
  private lastLivenessProbe = 0;
  private livenessStrikes = 0;
  private static readonly LIVENESS_QUIET_MS = 3_000;  // quiet this long → probe
  private static readonly LIVENESS_PROBE_MS = 3_000;  // at most one probe per interval
  private static readonly LIVENESS_STRIKES  = 2;      // consecutive failures → drop SSE

  // Note contact with the device. Emits 'alive' at most every 2s so a busy
  // stream does not flood listeners.
  private markAlive(): void {
    const now = Date.now();
    this.lastActivity = now;
    this.livenessStrikes = 0;
    if (now - this.lastAliveEmit >= 2_000) {
      this.lastAliveEmit = now;
      this.emit('alive');
    }
  }
  private sseStarting = false;            // SSE connection attempt in progress
  private sseSocket: any = null;          // raw TLS socket for SSE (no timeout)
  private sseSessionId: string | null = null;
  private ssePermFailed = false;          // SSE returned a permanent error (401) — don't retry
  private sseSubscribePaths: string[] | null = null;  // null = not yet probed
  // UDP SSCv1 receiver (EW-DX live telemetry on port 45 — separate from SSCv2 HTTPS)
  private udpSocket: dgram.Socket | null = null;
  private udpHeartbeat: NodeJS.Timeout | null = null;
  private udpStarted   = false;   // socket created and subscription sent
  private udpDataActive = false;  // received at least one message with rx data
  private udpLoggedOnce = false;
  // EW-DX OpenAPI 1.7: per-channel state accumulated from multiple sub-path SSE events
  private ewdxChannelCache: Map<number, Record<string, any>> = new Map();
  private ewdxInitialFetchDone = false;

  getPassword(): string | null { return this.password; }

  constructor(ip: string, port: number, password?: string | null) {
    super();
    this.ip = ip;
    this.port = port;
    this.password = password ?? null;

    // Sennheiser EW-DX V4+ uses HTTP Basic auth with username "api".
    // The Sennheiser Cockpit Control app locks the username to "api" and only
    // exposes the password field to the user.
    const authHeader = password
      ? { Authorization: `Basic ${Buffer.from(`api:${password}`).toString('base64')}` }
      : {};

    log.debug(`[SSCClient] ${ip}:${port} — password ${password ? `SET (len=${password.length})` : 'NOT SET'}`);

    // Allow self-signed certs and legacy TLS (TLS 1.0/1.1) used by older Sennheiser firmware.
    // Node.js 24 (OpenSSL 3.x) disables TLS 1.0/1.1 by default; we re-enable it at the
    // server process level via --tls-min-v1.0 (set in desktop/main.ts) and here via minVersion.
    // SECLEVEL=0 allows weak cipher suites that older embedded firmware may require.
    this.httpsClient = axios.create({
      timeout: 2000,
      headers: authHeader,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
        minVersion: 'TLSv1' as any,
        ciphers: 'DEFAULT@SECLEVEL=0',
      }),
    });

    this.httpClient = axios.create({ timeout: 2000, headers: authHeader });
  }

  startPolling(intervalMs: number = 500) {
    if (this.interval) return;
    this.interval = setInterval(() => this.poll(), intervalMs);
  }

  stopPolling() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Close any active SSE connection
    if (this.sseSocket) {
      try { this.sseSocket.destroy(); } catch { /* ignore */ }
      this.sseSocket = null;
    }
    this.sseActive         = false;
    this.sseStarting       = false;
    this.sseSessionId      = null;
    this.ssePermFailed     = false;
    this.sseSubscribePaths = null;
    this.isConnected = false;
    this.activeUrl = null;
    this.baseUrl = null;
    this.isSSCv2 = false;
    this.metadataFetched = false;
    this.sscv2RxMissing = false;
    this.emptyPollCount = 0;
    this.ewdxChannelCache.clear();
    this.ewdxInitialFetchDone = false;
    this.stopUdpReceiver();
  }

  private clientFor(scheme: Scheme): AxiosInstance {
    return scheme === 'https' ? this.httpsClient : this.httpClient;
  }

  // Derive the base URL (scheme + host) from the active probe URL.
  private extractBase(url: string): string {
    const m = url.match(/^(https?:\/\/[^/]+)/);
    return m ? m[1] : url;
  }

  // On first connection, try every candidate sequentially until one succeeds.
  // Returns the response data and caches the working URL in this.activeUrl.
  private async probe(): Promise<any> {
    let lastErr: unknown;
    for (const { scheme, path } of PROBE_CANDIDATES) {
      // If a previous SSCv2 attempt connected but had no rx data, skip /api/*
      // candidates so we fall straight through to /osc/.
      if (this.sscv2RxMissing && path.startsWith('/api')) {
        log.debug(`[SSCClient] ${this.ip}: skipping ${path} (SSCv2 rx data not available)`);
        continue;
      }

      const url = `${scheme}://${this.ip}:${this.port}${path}`;
      try {
        const response = await this.clientFor(scheme).get(url, { timeout: 2000 });
        // Reject non-JSON responses (e.g. a router/switch serving an HTML login page
        // at /osc/ or another path that happens to return 200).
        if (!response.data || typeof response.data !== 'object') {
          log.debug(`[SSCClient] Probe ${url}: 200 but non-JSON body — not a Sennheiser device`);
          lastErr = new Error(`non-JSON response at ${url}`);
          continue;
        }
        this.activeUrl     = url;
        this.baseUrl       = this.extractBase(url);
        this.isSSCv2       = url.includes('/api/');
        this.ssePermFailed = false;   // allow SSE attempt on fresh probe
        log.debug(`[SSCClient] ${this.ip}:${this.port} — connected via ${url} (${this.isSSCv2 ? 'SSCv2' : 'OSC'})`);
        log.debug(`[SSCClient] ${this.ip} probe response body: ${JSON.stringify(response.data).substring(0, 400)}`);
        return response.data;
      } catch (err: any) {
        const detail = err.response
          ? `HTTP ${err.response.status}`
          : (err.code ?? err.message ?? 'unknown');
        log.debug(`[SSCClient] Probe ${url}: ${detail}`);
        if (err.response?.status === 401) {
          const challenge = err.response.headers?.['www-authenticate'] ?? '(none)';
          const sentAuth  = (this.httpsClient.defaults.headers as any)?.['Authorization']
                         ?? (this.httpsClient.defaults.headers as any)?.common?.['Authorization']
                         ?? '(not set)';
          log.warn(
            `[SSCClient] ${this.ip} 401 on ${path} — ` +
            `password ${this.password ? `SET (len=${this.password.length})` : 'NOT SET'}, ` +
            `sent Authorization: ${sentAuth !== '(not set)' ? sentAuth.substring(0, 20) + '…' : '(not set)'}, ` +
            `WWW-Authenticate: ${challenge}`,
          );
        }
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // Normalize a raw rx object into our internal format.
  // Handles field-name variation across EW-DX firmware versions and OSC/SSCv2 modes.
  private normalizeRx(raw: any): Record<string, any> | null {
    if (!raw || typeof raw !== 'object') return null;

    const freq = raw.frequency ?? raw.freq;
    const freqKhz = !freq ? 0
      : freq > 1_000_000 ? Math.round(freq / 1000)   // Hz → kHz
      : freq > 1_000     ? Math.round(freq)            // already kHz
      :                    Math.round(freq * 1000);    // MHz → kHz

    const rfQ  = raw.rf_quality ?? raw.rf?.quality ?? raw.rf?.level_a ?? raw.rf?.field_strength ?? 0;
    const rfQb = raw.rf_quality_b ?? raw.rf?.quality_b ?? raw.rf?.level_b ?? rfQ;

    const afLvl = raw.af_level ?? raw.audio?.level ?? raw.audio?.af_level ?? -100;

    let battery: { percent: number } | undefined;
    if (raw.battery && typeof raw.battery === 'object') {
      const pct = raw.battery.percent ?? raw.battery.level;
      if (pct !== undefined) battery = { percent: Number(pct) };
    }

    return {
      name:         raw.name ?? raw.channel_name ?? null,
      frequency:    freqKhz,
      rf_quality:   Math.min(100, Math.max(0, Number(rfQ)  || 0)),
      rf_quality_b: Math.min(100, Math.max(0, Number(rfQb) || 0)),
      af_level:     Number(afLvl) || -100,
      mute:         Boolean(raw.mute ?? raw.audio?.mute ?? false),
      squelch:      Boolean(raw.squelch ?? raw.rf?.squelch ?? false),
      battery,
    };
  }

  // Extract a normalised rxKey ("rx1", "rx2", …) from any supported path format.
  // EW-DX OpenAPI 1.7 uses 0-indexed /api/channel/{id} (and sub-paths); all others are 1-indexed.
  private rxKeyFromPath(path: string): string | null {
    // EW-DX OpenAPI 1.7: /api/channel/0 or /api/channel/0/subpath → rx1
    const mEwdx = path.match(/^\/api\/channel\/(\d+)(?:\/|$)/);
    if (mEwdx) return `rx${parseInt(mEwdx[1]) + 1}`;
    // Legacy: /api/rx1, /api/rx/1, /api/receiver/1, /api/ch1, /api/ch/1
    const m = path.match(/^\/api\/(?:rx|receiver|ch)\/?(\d+)$/);
    return m ? `rx${m[1]}` : null;
  }

  // Accumulate per-channel state for EW-DX OpenAPI 1.7 devices where real-time data
  // arrives as separate SSE events from multiple sub-paths (/signalQualityIndicator, /level, etc.)
  private mergeEwdxState(chId: number, update: Record<string, any>): void {
    const current = this.ewdxChannelCache.get(chId) ?? {};
    const merged  = { ...current };
    for (const [k, v] of Object.entries(update)) {
      if (v !== undefined && v !== null) merged[k] = v;
    }
    this.ewdxChannelCache.set(chId, merged);
    // Only emit once we have at least one meaningful signal field
    if (merged.rf_quality !== undefined || merged.name !== undefined || merged.mute !== undefined) {
      const norm = this.normalizeRx(this.buildEwdxRxObj(merged));
      if (norm) {
        this.failCount = 0;
        if (!this.isConnected) { this.isConnected = true; this.emit('connected'); }
        this.emit('state', { [`rx${chId + 1}`]: norm });
      }
    }
  }

  // Build a normalizeRx-compatible object from the accumulated EW-DX per-channel cache.
  private buildEwdxRxObj(cached: Record<string, any>): Record<string, any> {
    return {
      name:         cached.name,
      frequency:    cached.frequency,          // kHz from /api/rf/channels/{id}
      rf_quality:   cached.rf_quality,         // 0-100 from signalQualityIndicator
      rf_quality_b: cached.rf_quality,
      af_level:     cached.af_level,           // dBfs from /api/channel/{id}/level
      mute:         cached.mute,
      battery:      cached.battery_percent != null
                      ? { percent: cached.battery_percent }
                      : undefined,
    };
  }

  // ── SSCv2 SSE subscription ───────────────────────────────────────────────
  // Per the Sennheiser 3rd-party API spec (SSCv2 v2.3, EW-DX OpenAPI 1.7):
  //  1. GET /api/ssc/state/subscriptions with Accept: text/event-stream
  //     → server opens an SSE stream and sends {sessionUUID:"..."} as first event
  //  2. PUT /api/ssc/state/subscriptions/{uuid}/add  body: ["rx1","rx2",...]
  //     → server pushes SSE events whenever subscribed values change
  // Direct GET on /api/rx1 returns 404 — data is push-only via SSE.

  // Use httpsClient (same auth + TLS settings as every other request) with
  // responseType:'stream' so axios resolves once headers arrive but keeps the
  // connection open for the long-lived SSE body.
  private startSSCv2Subscription(): void {
    if (this.sseStarting || this.sseActive || this.ssePermFailed) return;
    this.sseStarting = true;

    this.httpsClient.get(`${this.baseUrl}/api/ssc/state/subscriptions`, {
      headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
      responseType: 'stream',
      timeout: 0,   // disable per-request timeout — SSE is a persistent connection
    }).then((resp: any) => {
      if ((resp.status as number) !== 200) {
        log.debug(`[SSCClient] ${this.ip} SSE /api/ssc/state/subscriptions → HTTP ${resp.status}`);
        this.sseStarting = false;
        return;
      }

      log.debug(`[SSCClient] ${this.ip} SSE stream opened`);
      this.sseActive   = true;
      // The subscription was accepted, so whatever password is stored works.
      this.emit('auth-ok');
      this.sseStarting = false;
      if (!this.isConnected) {
        this.isConnected = true;
        this.emit('connected');
      }

      const stream: NodeJS.ReadableStream = resp.data;
      this.sseSocket = stream;
      let buf = '';

      const resetSSE = (reason: string) => {
        const wasActive = this.sseActive;
        this.sseActive    = false;
        this.sseStarting  = false;
        this.sseSessionId = null;
        this.sseSocket    = null;
        if (wasActive) {
          log.debug(`[SSCClient] ${this.ip} SSE ${reason} — will re-probe`);
          this.activeUrl            = null;
          this.baseUrl              = null;
          this.isSSCv2              = false;
          this.metadataFetched      = false;
          this.sscv2DiagLogged      = false;
          this.ewdxInitialFetchDone = false;
        }
      };

      stream.on('data', (chunk: Buffer) => {
        // Any traffic at all — a value, a keepalive comment, a blank line — is
        // proof the device is there, whether or not it parses to telemetry.
        this.markAlive();
        buf += chunk.toString('utf8');
        // SSE events are delimited by blank lines (\n\n or \r\n\r\n)
        let boundary: number;
        while ((boundary = buf.search(/\r?\n\r?\n/)) !== -1) {
          const eventText = buf.slice(0, boundary);
          // Skip past the delimiter (up to 4 chars: \r\n\r\n)
          const after = buf.slice(boundary).match(/^(\r?\n){1,2}/);
          buf = buf.slice(boundary + (after?.[0]?.length ?? 2));

          let data = '';
          for (const line of eventText.split(/\r?\n/)) {
            if (line.startsWith('data:')) data += line.slice(5).trimStart();
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);

            // ── Path-based state event: {"path":"...","value":{...}} ──────────
            if (typeof parsed.path === 'string' && parsed.value !== undefined) {
              const epath = parsed.path as string;

              // ── EW-DX OpenAPI 1.7 sub-path events ────────────────────────────
              // Each metric arrives as a separate SSE event; we accumulate them in
              // ewdxChannelCache and re-emit a merged state object.
              let ewdxHandled = false;
              const sqiM = epath.match(/^\/api\/channel\/(\d+)\/signalQualityIndicator$/);
              if (sqiM) { this.mergeEwdxState(parseInt(sqiM[1]), { rf_quality: parsed.value.value }); ewdxHandled = true; }
              const lvlM = epath.match(/^\/api\/channel\/(\d+)\/level$/);
              if (lvlM) { this.mergeEwdxState(parseInt(lvlM[1]), { af_level: parsed.value.value }); ewdxHandled = true; }
              const chM = epath.match(/^\/api\/channel\/(\d+)$/);
              if (chM)  { this.mergeEwdxState(parseInt(chM[1]),  { name: parsed.value.name, mute: parsed.value.mute }); ewdxHandled = true; }
              const rfM = epath.match(/^\/api\/rf\/channels\/(\d+)$/);
              if (rfM)  { this.mergeEwdxState(parseInt(rfM[1]),  { frequency: parsed.value.frequency }); ewdxHandled = true; }
              const batM = epath.match(/^\/api\/transmitters\/(\d+)\/battery$/);
              if (batM) { this.mergeEwdxState(parseInt(batM[1]), { battery_percent: parsed.value.gauge }); ewdxHandled = true; }
              if (ewdxHandled) continue;
              // ── end EW-DX ─────────────────────────────────────────────────────

              // ── Legacy path formats: /api/rx1, /api/rx/1, /api/ch1, etc. ─────
              const rxKey = this.rxKeyFromPath(epath);
              if (rxKey) {
                const norm = this.normalizeRx(parsed.value);
                if (norm) { this.failCount = 0; this.emit('state', { [rxKey]: norm }); }
                continue;
              }
              // Unknown path — log it so we can identify the correct receiver paths
              if (!/\/api\/ssc\/state\/subscriptions/.test(epath)) {
                log.debug(`[SSCClient] ${this.ip} SSE unknown path: ${epath} = ${JSON.stringify(parsed.value).substring(0, 300)}`);
              }
              continue;
            }

            // ── Session UUID (first event after opening stream) ───────────────
            if (!this.sseSessionId) {
              const uuid = parsed.sessionUUID ?? parsed.session_uuid
                ?? parsed.session?.uuid ?? null;
              if (uuid) {
                this.sseSessionId = uuid;
                log.debug(`[SSCClient] ${this.ip} SSE session: ${uuid}`);
                this.subscribeSSEChannels(uuid).catch(() => {});
              } else {
                log.debug(`[SSCClient] ${this.ip} SSE first event: ${JSON.stringify(parsed).substring(0, 200)}`);
              }
              continue; // first event handled
            }

            // ── Compound state: {"rx1":{...}} or SSCv2 path-as-key {"/api/rx1":{...}} ────
            const rxData: Record<string, any> = {};
            let ewdxHandled2 = false;
            for (const [k, v] of Object.entries(parsed)) {
              if (!v || typeof v !== 'object') continue;

              // EW-DX OpenAPI 1.7: path is the JSON key, value is the sub-resource object.
              // Route each sub-path to mergeEwdxState instead of normalizeRx.
              const sqiC = k.match(/^\/api\/channel\/(\d+)\/signalQualityIndicator$/);
              if (sqiC) { this.mergeEwdxState(parseInt(sqiC[1]), { rf_quality: (v as any).value }); ewdxHandled2 = true; continue; }
              const lvlC = k.match(/^\/api\/channel\/(\d+)\/level$/);
              if (lvlC) { this.mergeEwdxState(parseInt(lvlC[1]), { af_level: (v as any).value }); ewdxHandled2 = true; continue; }
              const chC = k.match(/^\/api\/channel\/(\d+)$/);
              if (chC)  { this.mergeEwdxState(parseInt(chC[1]),  { name: (v as any).name, mute: (v as any).mute }); ewdxHandled2 = true; continue; }
              const rfC = k.match(/^\/api\/rf\/channels\/(\d+)$/);
              if (rfC)  { this.mergeEwdxState(parseInt(rfC[1]),  { frequency: (v as any).frequency }); ewdxHandled2 = true; continue; }
              const batC = k.match(/^\/api\/transmitters\/(\d+)\/battery$/);
              if (batC) { this.mergeEwdxState(parseInt(batC[1]), { battery_percent: (v as any).gauge }); ewdxHandled2 = true; continue; }

              // Legacy: bare rx1/rx2 or /api/rx1 style keys
              const rxKey = this.rxKeyFromPath(k)
                ?? (/^rx\d+$/.test(k) ? k : null);
              if (rxKey) {
                const norm = this.normalizeRx(v);
                if (norm) rxData[rxKey] = norm;
              } else if (k !== 'path' && k !== 'sessionUUID' && k !== 'session_uuid') {
                log.debug(`[SSCClient] ${this.ip} SSE compound key: "${k}" = ${JSON.stringify(v).substring(0, 200)}`);
              }
            }
            if (Object.keys(rxData).length > 0) {
              this.failCount = 0;
              this.emit('state', rxData);
            } else if (!ewdxHandled2) {
              log.debug(`[SSCClient] ${this.ip} SSE event: ${JSON.stringify(parsed).substring(0, 200)}`);
            }
          } catch { /* keepalive comment or non-JSON line */ }
        }
      });
      stream.on('end',   () => resetSSE('stream ended'));
      stream.on('error', (err: Error) => { log.debug(`[SSCClient] ${this.ip} SSE error: ${err.message}`); resetSSE('stream error'); });

    }).catch((err: any) => {
      this.sseStarting = false;
      const status = err.response?.status as number | undefined;
      if (status === 401) {
        const challenge = (err.response?.headers?.['www-authenticate'] as string | undefined) ?? '(none)';
        log.warn(
          `[SSCClient] ${this.ip} SSE 401 on /api/ssc/state/subscriptions — ` +
          `WWW-Authenticate: ${challenge}. ` +
          `Password ${this.password ? `is SET (len=${this.password.length})` : 'NOT SET'}. ` +
          `SSE will not be retried until device is re-probed.`,
        );
        // Mark SSE as permanently failed so poll() stops retrying it.
        // Do NOT reset activeUrl/baseUrl/isSSCv2 — the device IS SSCv2 and is reachable.
        // poll() will keep the device online and use pollSSCv2Direct() as a fallback.
        this.ssePermFailed = true;
        // This is the one state an operator cannot diagnose from the UI without
        // help: the device shows connected, yet no channel ever appears. Say so.
        this.emit('auth-failed', {
          reason: this.password
            ? 'The device rejected the stored password.'
            : 'The device requires a password and none is stored.',
        });
      } else {
        log.debug(`[SSCClient] ${this.ip} SSE → ${status ?? err.code ?? err.message}`);
      }
    });
  }

  private async subscribeSSEChannels(sessionId: string): Promise<void> {
    const url = `${this.baseUrl}/api/ssc/state/subscriptions/${sessionId}/add`;

    if (this.sseSubscribePaths && this.sseSubscribePaths.length > 0) {
      // EW-DX OpenAPI 1.7: /api/channel/{id} paths — subscribe to all real-time sub-paths
      if (this.sseSubscribePaths[0].startsWith('/api/channel/')) {
        const ewdxPaths = [
          '/api/channel/0/signalQualityIndicator',
          '/api/channel/0/level',
          '/api/channel/0/warnings',
          '/api/channel/1/signalQualityIndicator',
          '/api/channel/1/level',
          '/api/channel/1/warnings',
          '/api/channel/0',
          '/api/channel/1',
          '/api/rf/channels/0',
          '/api/rf/channels/1',
          '/api/transmitters/0/battery',
          '/api/transmitters/1/battery',
        ];
        for (let i = 0; i < ewdxPaths.length; i += 4) {
          const batch = ewdxPaths.slice(i, i + 4);
          try {
            const resp = await this.httpsClient.put(url, batch, { timeout: 5000 });
            log.debug(`[SSCClient] ${this.ip} SSE subscribed [${batch.join(', ')}] → ${resp.status}`);
          } catch (err: any) {
            const status = err.response?.status ?? err.code ?? err.message;
            const body   = err.response?.data
              ? ` body: ${JSON.stringify(err.response.data).substring(0, 200)}`
              : '';
            log.debug(`[SSCClient] ${this.ip} SSE subscribe batch ${i/4+1} → ${status}${body}`);
          }
        }
        return;
      }

      // Legacy: Known specific paths — subscribe in batches of 2
      const base = this.sseSubscribePaths.slice(0, 2);
      const ext  = this.sseSubscribePaths.slice(2, 4);
      try {
        const resp = await this.httpsClient.put(url, base, { timeout: 5000 });
        log.debug(`[SSCClient] ${this.ip} SSE subscribed to [${base.join(', ')}] → HTTP ${resp.status}`);
      } catch (err: any) {
        const status = err.response?.status ?? err.code ?? err.message;
        const body   = err.response?.data
          ? ` body: ${JSON.stringify(err.response.data).substring(0, 200)}`
          : '';
        log.debug(`[SSCClient] ${this.ip} SSE subscribe → ${status}${body}`);
        return;
      }
      if (ext.length > 0) {
        this.httpsClient.put(url, ext, { timeout: 5000 }).catch(() => {});
      }
    } else {
      // No specific rx paths found yet.
      // Try /api/device (parent of all device resources) — if accepted, the device will push
      // ALL /api/device/* sub-resource changes via SSE, which may reveal the rx path.
      // Fall back to /api/device/site if the parent subscription is rejected.
      const pathsToTry = ['/api/device', '/api/device/site'];
      for (const p of pathsToTry) {
        try {
          const resp = await this.httpsClient.put(url, [p], { timeout: 5000 });
          log.debug(`[SSCClient] ${this.ip} SSE subscribed to [${p}] → HTTP ${resp.status}`);
          break;
        } catch (err: any) {
          const status = err.response?.status ?? err.code ?? err.message;
          const body   = err.response?.data
            ? ` body: ${JSON.stringify(err.response.data).substring(0, 200)}`
            : '';
          log.debug(`[SSCClient] ${this.ip} SSE subscribe [${p}] → ${status}${body}`);
        }
      }
    }
  }

  // Probe candidate rx path formats in parallel to discover which one this device uses.
  // Results are cached in sseSubscribePaths. Call once per probe (before starting SSE).
  private async discoverChannelPaths(): Promise<void> {
    if (this.sseSubscribePaths !== null) return;

    const candidates: string[][] = [
      // EW-DX OpenAPI 1.7: 0-indexed integer channel IDs (EM 2 = ch 0–1, EM 4 = ch 0–3)
      ['/api/channel/0',      '/api/channel/1',      '/api/channel/2',      '/api/channel/3'],
      ['/api/rx1',            '/api/rx2',            '/api/rx3',            '/api/rx4'],
      ['/api/rx/1',           '/api/rx/2',           '/api/rx/3',           '/api/rx/4'],
      ['/api/receiver/1',     '/api/receiver/2',     '/api/receiver/3',     '/api/receiver/4'],
      ['/api/ch1',            '/api/ch2',            '/api/ch3',            '/api/ch4'],
      ['/api/ch/1',           '/api/ch/2',           '/api/ch/3',           '/api/ch/4'],
      ['/api/slot/1',         '/api/slot/2',         '/api/slot/3',         '/api/slot/4'],
      ['/api/mate/1',         '/api/mate/2',         '/api/mate/3',         '/api/mate/4'],
      ['/api/device/rx1',     '/api/device/rx2',     '/api/device/rx3',     '/api/device/rx4'],
      ['/api/device/rx/1',    '/api/device/rx/2',    '/api/device/rx/3',    '/api/device/rx/4'],
      ['/api/audio/rx/1',     '/api/audio/rx/2',     '/api/audio/rx/3',     '/api/audio/rx/4'],
      ['/api/ssc/rx1',        '/api/ssc/rx2',        '/api/ssc/rx3',        '/api/ssc/rx4'],
      // SSCv1 JSON path structure mirrored into SSCv2: m.rx1 → /api/m/rx1, mates.tx1 → /api/mates/tx1
      ['/api/m/rx1',          '/api/m/rx2',          '/api/m/rx3',          '/api/m/rx4'],
      ['/api/mates/tx1',      '/api/mates/tx2',      '/api/mates/tx3',      '/api/mates/tx4'],
    ];

    type Hit = { paths: string[]; status: number };

    const probe = async (paths: string[]): Promise<Hit> => {
      try {
        const resp = await this.httpsClient.get(`${this.baseUrl}${paths[0]}`, { timeout: 2000 });
        return { paths, status: resp.status };
      } catch (err: any) {
        const status: number | undefined = err.response?.status;
        if (status !== undefined && status !== 404) return { paths, status };
        throw new Error(`${paths[0]} → ${status ?? err.code}`);
      }
    };

    const results = await Promise.allSettled(candidates.map(probe));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        this.sseSubscribePaths = result.value.paths;
        log.debug(
          `[SSCClient] ${this.ip} rx paths: ${result.value.paths.slice(0, 2).join(', ')} ` +
          `(HTTP ${result.value.status})`,
        );
        return;
      }
    }

    // All channel parent paths 404'd. Probe structural and diagnostic paths to discover
    // what this device actually exposes — these results appear in the log and guide next steps.
    const diagnosticProbes = [
      // API root — some devices return a list of available top-level resources
      '/api/',
      // OpenAPI spec — device may self-document its endpoints
      '/api/openapi',
      '/api/openapi.json',
      // SSCv1 JSON structure mapped directly: m.rx1, mates.tx1
      '/api/m',
      '/api/m/rx1',
      '/api/mates',
      '/api/mates/tx1',
      // Device-level paths from companion module's getStaticInformation()
      '/api/device/frequency_code',
      '/api/device/network/ipv4',
      '/api/device/network/dante/ipv4',
      // Leaf properties on rx1
      '/api/rx1/frequency',
      '/api/rx1/mute',
      '/api/rx1/name',
    ];
    for (const p of diagnosticProbes) {
      try {
        const resp = await this.httpsClient.get(`${this.baseUrl}${p}`, { timeout: 2000 });
        log.debug(`[SSCClient] ${this.ip} FOUND: ${p} → ${resp.status}: ${JSON.stringify(resp.data).substring(0, 300)}`);
      } catch (err: any) {
        const status = err.response?.status ?? err.code;
        if (status !== 404) {
          log.debug(`[SSCClient] ${this.ip} non-404: ${p} → ${status}`);
        }
      }
    }
    this.sseSubscribePaths = [];
  }

  // ── UDP SSCv1 receiver (EW-DX live telemetry) ────────────────────────────
  // EW-DX uses SSCv2 HTTPS for configuration but SSCv1 JSON-over-UDP (port 45)
  // for real-time receiver telemetry (RF quality, frequency, battery, mute).

  private startUdpReceiver(): void {
    if (this.udpStarted) return;
    this.udpStarted = true;

    // Firewall rule for inbound UDP :45 is managed by the Electron main process
    // (apps/desktop/src/main.ts → ensureWindowsFirewall) at app startup.

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udpSocket = socket;
    socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      const text = msg.toString('utf8');
      if (!this.udpDataActive && !this.udpLoggedOnce) {
        log.debug(`[SSCClient] ${this.ip} UDP first packet from ${rinfo.address}:${rinfo.port}: ${text.substring(0, 200)}`);
      }
      if (rinfo.address !== this.ip) return;
      try { this.parseUdpMessage(JSON.parse(text)); } catch { /* non-JSON */ }
    });
    socket.on('error', (err: Error) => {
      log.debug(`[SSCClient] ${this.ip} UDP error: ${err.message}`);
    });
    // Bind to port 0 (random ephemeral), matching the companion module's approach.
    // The device records our source port from the subscription packet and pushes
    // telemetry back to that exact port. Windows Firewall stateful tracking allows
    // the response without requiring an explicit inbound rule.
    socket.bind(0, () => {
      const { port: localPort } = socket.address() as any;
      log.debug(`[SSCClient] ${this.ip} UDP SSCv1 bound :${localPort} — sending subscription to ${this.ip}:45`);
      this.sendUdpSubscription();
      this.udpHeartbeat = setInterval(() => this.sendUdpSubscription(), 9000);
    });
  }

  private stopUdpReceiver(): void {
    if (this.udpHeartbeat) { clearInterval(this.udpHeartbeat); this.udpHeartbeat = null; }
    if (this.udpSocket)    { try { this.udpSocket.close(); } catch { /* ignore */ } this.udpSocket = null; }
    this.udpStarted    = false;
    this.udpDataActive = false;
    this.udpLoggedOnce = false;
  }

  private sendUdpSubscription(): void {
    if (!this.udpSocket) return;

    // Exact subscription format from companion-module-sennheiser-ewdx ewdxReceiver.ts.
    // Includes sync_settings and all TX fields to match byte-for-byte what Companion sends.

    const rxBlock = {
      warnings: null, divi: null, frequency: null, name: null,
      identification: { visual: null },
      gain: null, mute: null,
      sync_settings: {
        trim_ignore: null, name_ignore: null, mute_config_ignore: null,
        lowcut_ignore: null, lock_ignore: null, led_ignore: null,
        frequency_ignore: null, cable_emulation_ignore: null,
        trim: null, mute_config_ts: null, mute_config: null,
        lowcut: null, lock: null, led: null, cable_emulation: null,
      },
    };

    const txBlock = {
      battery: { gauge: null, type: null, lifetime: null },
      capsule: null, mute: null, warnings: null, type: null,
      trim: null, name: null,
      mute_config_ts: null, mute_config: null, lowcut: null,
      lock: null, led: null, identification: null, cable_emulation: null,
    };

    // Message 1: RX channel state (lifetime 10 s)
    const msg1 = Buffer.from(JSON.stringify({
      osc: { state: { subscribe: [{ '#': { lifetime: 10 }, rx1: rxBlock, rx2: rxBlock }] } },
    }));

    // Message 2: TX mates (lifetime 60 s) + RF metrics
    const msg2 = Buffer.from(JSON.stringify({
      osc: { state: { subscribe: [
        { '#': { lifetime: 60 }, mates: { tx1: txBlock, tx2: txBlock } },
        { m: { rx1: { divi: null, rsqi: null }, rx2: { divi: null, rsqi: null } } },
      ]}},
    }));

    // Message 3: device settings (lifetime 60 s) — companion sends this too
    const msg3 = Buffer.from(JSON.stringify({
      osc: { state: { subscribe: [{ '#': { lifetime: 60 }, device: {
        encryption: null, brightness: null, booster: null, location: null,
        lock: null, link_density_mode: null, name: null, identification: null,
      }}] } },
    }));

    const send = (buf: Buffer) => this.udpSocket!.send(buf, 45, this.ip, (err) => {
      if (err) log.debug(`[SSCClient] ${this.ip} UDP send error: ${err.message}`);
    });
    send(msg1);
    send(msg2);
    send(msg3);
  }

  private parseUdpMessage(json: any): void {
    if (!json || typeof json !== 'object') return;
    const rxData: Record<string, any> = {};
    for (let i = 1; i <= 4; i++) {
      const rxKey = `rx${i}`;
      const txKey = `tx${i}`;
      const rxRaw = json[rxKey];
      const mRaw  = json.m?.[rxKey];
      if (!rxRaw && !mRaw) continue;
      const merged: Record<string, any> = rxRaw ? { ...rxRaw } : {};
      // RF signal quality from json.m.rx{n}.rsqi (0–100)
      if (mRaw?.rsqi != null) merged.rf_quality = Math.min(100, Math.max(0, Number(mRaw.rsqi)));
      // Battery from transmitter mates: gauge 0–5 bars → percent
      const txBattery = json.mates?.[txKey]?.battery;
      if (txBattery != null) {
        const gauge = typeof txBattery === 'object' ? txBattery.gauge : txBattery;
        if (typeof gauge === 'number') merged.battery = { percent: Math.min(100, Math.max(0, gauge * 20)) };
      }
      const norm = this.normalizeRx(merged);
      if (norm) rxData[rxKey] = norm;
    }
    if (Object.keys(rxData).length === 0) return;
    this.udpDataActive = true;
    this.markAlive();
    this.failCount = 0;
    if (!this.isConnected) {
      this.isConnected = true;
      this.emit('connected');
    }
    this.emit('state', rxData);
    if (!this.udpLoggedOnce) {
      this.udpLoggedOnce = true;
      log.debug(`[SSCClient] ${this.ip} UDP SSCv1 rx data: ${JSON.stringify(rxData).substring(0, 300)}`);
    }
  }

  // Poll SSCv2 channel data directly. For EW-DX OpenAPI 1.7 devices this fetches
  // the initial state from /api/channel/{id}, /api/rf/channels/{id}, and /api/transmitters/{id}/battery
  // once per connection, then returns the accumulated cache on subsequent calls (SSE handles updates).
  // For older firmware the legacy /api/rx{n} path is tried as a fallback.
  private sscv2DiagLogged = false;
  private async pollSSCv2Direct(): Promise<Record<string, any>> {
    // ── EW-DX OpenAPI 1.7 ─────────────────────────────────────────────────────
    if (this.sseSubscribePaths?.[0] === '/api/channel/0') {
      if (!this.ewdxInitialFetchDone) {
        this.ewdxInitialFetchDone = true;
        log.debug(`[SSCClient] ${this.ip} EW-DX initial channel fetch`);
        for (let chId = 0; chId < 4; chId++) {
          // Channel name + mute — primary check: 404 means no more channels
          try {
            const ch = await this.httpsClient.get(`${this.baseUrl}/api/channel/${chId}`, { timeout: 2000 });
            this.mergeEwdxState(chId, { name: ch.data.name, mute: ch.data.mute });
          } catch (err: any) {
            if (err.response?.status === 404) break;
            continue;
          }
          // Each remaining endpoint is best-effort — never abort the loop
          try {
            const sqi = await this.httpsClient.get(`${this.baseUrl}/api/channel/${chId}/signalQualityIndicator`, { timeout: 2000 });
            this.mergeEwdxState(chId, { rf_quality: sqi.data.value });
          } catch {}
          try {
            const rf = await this.httpsClient.get(`${this.baseUrl}/api/rf/channels/${chId}`, { timeout: 2000 });
            this.mergeEwdxState(chId, { frequency: rf.data.frequency });
          } catch {}
          try {
            const bat = await this.httpsClient.get(`${this.baseUrl}/api/transmitters/${chId}/battery`, { timeout: 2000 });
            this.mergeEwdxState(chId, { battery_percent: bat.data.gauge });
          } catch { /* 422 when no transmitter linked — normal */ }
        }
      }
      // Return current accumulated state so the poll loop sees non-empty data
      const result: Record<string, any> = {};
      for (const [chId, cached] of this.ewdxChannelCache) {
        const norm = this.normalizeRx(this.buildEwdxRxObj(cached));
        if (norm) result[`rx${chId + 1}`] = norm;
      }
      return result;
    }

    // ── Legacy /api/rx{n} path (older firmware) ────────────────────────────────
    const result: Record<string, any> = {};
    for (let i = 1; i <= 4; i++) {
      const rxKey = `rx${i}`;
      try {
        const resp = await this.httpsClient.get(`${this.baseUrl}/api/${rxKey}`);
        if (i === 1 && !this.sscv2DiagLogged) {
          this.sscv2DiagLogged = true;
          log.debug(
            `[SSCClient] ${this.ip} /api/rx1 → HTTP ${resp.status} ` +
            `body: ${JSON.stringify(resp.data).substring(0, 300)}`,
          );
        }
        const norm = this.normalizeRx(resp.data);
        if (norm) result[rxKey] = norm;
      } catch (err: any) {
        if (i === 1 && !this.sscv2DiagLogged) {
          this.sscv2DiagLogged = true;
          log.debug(`[SSCClient] ${this.ip} /api/rx1 → HTTP ${err.response?.status ?? err.code}`);
        }
        if (err.response?.status === 404) break;
        if (i === 1) throw err;
        break;
      }
    }
    return result;
  }

  // Poll /osc/rx1, /osc/rx2, … individually; the root /osc/ is only a probe target.
  private oscLoggedOnce = false;
  private async pollOsc(): Promise<Record<string, any>> {
    const scheme = this.activeUrl!.startsWith('https') ? 'https' : 'http';
    const client = this.clientFor(scheme);
    const result: Record<string, any> = {};

    for (let i = 1; i <= 4; i++) {
      const rxKey = `rx${i}`;
      const rxUrl = `${this.baseUrl}/osc/${rxKey}`;
      try {
        const resp = await client.get(rxUrl);
        if (!this.oscLoggedOnce) {
          this.oscLoggedOnce = true;
          log.debug(`[SSCClient] ${this.ip} OSC rx1 raw:`, JSON.stringify(resp.data).substring(0, 400));
        }
        const norm = this.normalizeRx(resp.data);
        if (norm) result[rxKey] = norm;
      } catch (err: any) {
        if (err.response?.status === 404) break;
        if (i === 1) throw err;
        break;
      }
    }
    return result;
  }

  // Fetch device identity (firmware, serial, mac) and emit a metadata event.
  // Called once after first connect and periodically thereafter.
  private async fetchMetadata() {
    if (!this.baseUrl) return;
    try {
      const scheme = this.activeUrl?.startsWith('https') ? 'https' : 'https';
      const resp = await this.clientFor(scheme).get(`${this.baseUrl}/api/device/identity`, { timeout: 3000 });
      const raw = resp.data ?? {};
      // Log the full raw body once so we can see every field the device returns
      if (!this.metadataFetched) {
        log.debug(`[SSCClient] ${this.ip} /api/device/identity full body: ${JSON.stringify(raw)}`);
      }
      const meta = {
        deviceName: raw.device_name ?? raw.name ?? raw.title ?? null,
        firmware:   raw.firmware_version ?? raw.version ?? raw.fw_version ?? null,
        serial:     raw.serial_number ?? raw.serial ?? raw.sn ?? null,
        // Sennheiser devices may use mac_eth, mac_address, mac, or ethernet_mac
        mac:        raw.mac_address ?? raw.mac ?? raw.ethernet_mac ?? raw.mac_eth ?? null,
        model:      raw.device_type ?? raw.model ?? raw.type ?? raw.product_name ?? null,
      };
      log.debug(
        `[SSCClient] ${this.ip} /api/device/identity → ` +
        `MAC: ${meta.mac ?? 'null'}, serial: ${meta.serial ?? 'null'}, model: ${meta.model ?? 'null'}`,
      );
      this.emit('metadata', meta);
    } catch (err: any) {
      if (!this.metadataFetched) {
        const status = err.response?.status ?? err.code ?? err.message ?? 'unknown';
        log.debug(`[SSCClient] ${this.ip} /api/device/identity → ${status}`);
      }
    }
    this.metadataFetched = true;
  }

  // One-shot network-config probe: asks the device (via whichever of its IPs
  // answered) which addresses belong to its control interface vs its Dante
  // interface.  Used to tell the two NICs of an EW-DX apart during reconcile —
  // MAC comparison is unreliable because in switched (single-cable) mode both
  // logical interfaces may share the physical port.
  // `controlAddrs`/`danteAddrs` hold values from address-named keys only (no
  // netmasks/gateways); `controlAll`/`danteAll` hold every IPv4 in the payload
  // and are what membership checks should use.
  static async fetchNetworkAddresses(
    ip: string, port: number, password: string | null,
  ): Promise<{ controlAddrs: string[]; controlAll: string[]; danteAddrs: string[]; danteAll: string[] } | null> {
    const authHeader = password
      ? { Authorization: `Basic ${Buffer.from(`api:${password}`).toString('base64')}` }
      : {};
    const client = axios.create({
      timeout: 3000,
      headers: authHeader,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
        minVersion: 'TLSv1' as any,
        ciphers: 'DEFAULT@SECLEVEL=0',
      }),
    });

    const IPV4_RE = /^(\d{1,3}(?:\.\d{1,3}){3})/;
    const ADDR_KEY_RE = /^(address(es)?|ip|ipaddr|ip_address|ipv4)$/i;
    const collect = (node: any, all: Set<string>, addrs: Set<string>, key?: string) => {
      if (node == null) return;
      if (typeof node === 'string') {
        const m = node.match(IPV4_RE);
        if (m) {
          all.add(m[1]);
          if (key && ADDR_KEY_RE.test(key)) addrs.add(m[1]);
        }
      } else if (Array.isArray(node)) {
        for (const item of node) collect(item, all, addrs, key);
      } else if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) collect(v, all, addrs, k);
      }
    };

    const fetchPath = async (path: string) => {
      try {
        const resp = await client.get(`https://${ip}:${port}${path}`);
        const all = new Set<string>();
        const addrs = new Set<string>();
        collect(resp.data, all, addrs);
        return { all: [...all], addrs: [...addrs] };
      } catch {
        return null;
      }
    };

    const [control, dante] = await Promise.all([
      fetchPath('/api/device/network/ipv4'),
      fetchPath('/api/device/network/dante/ipv4'),
    ]);
    if (!control && !dante) return null;
    return {
      controlAddrs: control?.addrs ?? [],
      controlAll:   control?.all   ?? [],
      danteAddrs:   dante?.addrs   ?? [],
      danteAll:     dante?.all     ?? [],
    };
  }

  // One-shot identity probe used by DeviceManagerService for auto IP-change reconciliation.
  // Returns the MAC address if `/api/device/identity` responds with auth, null otherwise.
  static async fetchIdentity(
    ip: string, port: number, password: string | null,
  ): Promise<{ mac: string | null; serial: string | null } | null> {
    const authHeader = password
      ? { Authorization: `Basic ${Buffer.from(`api:${password}`).toString('base64')}` }
      : {};
    const client = axios.create({
      timeout: 3000,
      headers: authHeader,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
        minVersion: 'TLSv1' as any,
        ciphers: 'DEFAULT@SECLEVEL=0',
      }),
    });
    try {
      const resp = await client.get(`https://${ip}:${port}/api/device/identity`);
      const raw = resp.data ?? {};
      return {
        mac:    raw.mac_address ?? raw.mac ?? raw.ethernet_mac ?? null,
        serial: raw.serial_number ?? raw.serial ?? raw.sn ?? null,
      };
    } catch {
      return null;
    }
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      let data: any;

      if (this.activeUrl) {
        if (this.isSSCv2) {
          // SSCv2: real-time data comes via SSE (config paths) and/or UDP SSCv1 (rx telemetry).
          this.startUdpReceiver();
          if (this.sseActive) {
            // SSE delivers data on change only, so silence here is ambiguous:
            // a quiet receiver and a dead stream look identical. When nothing
            // has arrived for a while, ask the device directly rather than
            // assume either way.
            const now = Date.now();
            const quietFor = now - this.lastActivity;
            if (quietFor > SSCClient.LIVENESS_QUIET_MS &&
                now - this.lastLivenessProbe > SSCClient.LIVENESS_PROBE_MS) {
              this.lastLivenessProbe = now;
              try {
                await this.httpsClient.get(`${this.baseUrl}/api/ssc/version`, { timeout: 2000 });
                this.markAlive();
              } catch (err: any) {
                this.livenessStrikes++;
                log.debug(
                  `[SSCClient] ${this.ip} liveness probe failed ` +
                  `(${this.livenessStrikes}/${SSCClient.LIVENESS_STRIKES}): ${err?.code ?? err?.message}`,
                );
                if (this.livenessStrikes >= SSCClient.LIVENESS_STRIKES) {
                  // Tear the stream down through its own error path so the
                  // existing reconnect and disconnect accounting take over.
                  log.debug(`[SSCClient] ${this.ip} unreachable behind a silent SSE stream — dropping it`);
                  this.livenessStrikes = 0;
                  try { this.sseSocket?.destroy(new Error('liveness probe failed')); } catch { /* ignore */ }
                }
              }
              return;
            }
            this.failCount = 0;
            this.disconnectSignaled = false;
            return;
          }
          if (this.sseStarting) {
            // SSE connection attempt in progress — wait for it
            return;
          }
          // SSE not yet started: try direct GET polling (older SSCv2 firmware
          // that serves /api/rx1 directly) while also opening the SSE channel.
          this.startSSCv2Subscription();
          data = await this.pollSSCv2Direct();

          if (Object.keys(data).length === 0) {
            if (this.udpDataActive) return; // UDP is delivering live telemetry — no fallback needed
            this.emptyPollCount++;
            if (this.emptyPollCount >= 20) {
              this.emptyPollCount = 0;
              if (this.ssePermFailed) {
                // SSE auth failed AND direct GET has no data (EW-DX: SSE-only for rx data).
                // Keep the device online (it IS reachable via SSCv2) but don't fall through
                // to OSC/G3G4 — that would cause a spurious disconnect and G3G4 spam.
                // The device will show as "online" in inventory without channel data until
                // the SSE auth issue is resolved.
                log.warn(
                  `[SSCClient] ${this.ip} SSCv2 connected but no rx data accessible ` +
                  `(SSE auth failed, direct GET 404). Device stays online without channels.`,
                );
              } else {
                // SSE never connected + direct GET empty = rx not available via SSCv2.
                // Try falling back to /osc/ (older firmware).
                log.warn(
                  `[SSCClient] ${this.ip}:${this.port} SSCv2 GET and SSE both ` +
                  `returned no rx data. Falling back to OSC.`,
                );
                this.sscv2RxMissing    = true;
                this.stopUdpReceiver();
                this.sseSubscribePaths = null;
                this.activeUrl         = null;
                this.baseUrl           = null;
                this.isSSCv2           = false;
                this.metadataFetched   = false;
              }
            }
            return;
          }
          this.emptyPollCount = 0;
          if (this.metadataFetched && (this.failCount === 0) && Math.random() < 1 / 600) {
            this.fetchMetadata().catch(() => {});
          }
        } else {
          // OSC / legacy mode
          data = await this.pollOsc();
        }
      } else {
        // activeUrl is null: either first connection or post-SSCv2-fallback reset.
        await this.probe();
        if (this.isSSCv2) {
          await this.discoverChannelPaths();
          this.startUdpReceiver();
          this.startSSCv2Subscription();
          data = await this.pollSSCv2Direct();
          this.fetchMetadata().catch(() => {});
        } else {
          data = await this.pollOsc();
        }
      }

      this.failCount = 0;
      this.disconnectSignaled = false;
      if (!this.isConnected) {
        this.isConnected = true;
        this.emit('connected');
      }
      // Only emit state if there is meaningful telemetry (rx1, rx2, etc.)
      if (data && typeof data === 'object' && Object.keys(data).some(k => /^rx\d+$/.test(k))) {
        this.emit('state', data);
      }
    } catch (err: any) {
      const reason = (err.code ?? err.message ?? 'unknown') as string;

      if (this.isConnected) {
        this.isConnected          = false;
        this.activeUrl            = null;
        this.baseUrl              = null;
        this.isSSCv2              = false;
        this.sseSubscribePaths    = null;
        this.metadataFetched      = false;
        this.failCount            = 0;
        this.ewdxChannelCache.clear();
        this.ewdxInitialFetchDone = false;
        this.stopUdpReceiver();
        this.disconnectSignaled = true;
        log.warn(`[SSCClient] Lost connection to ${this.ip}:${this.port} — ${reason}`);
        this.emit('disconnected', reason);
      } else {
        this.failCount++;
        if (this.failCount === 1) {
          log.warn(`[SSCClient] ${this.ip}:${this.port} unreachable — ${reason}`);
        }
        if (!this.disconnectSignaled) {
          this.disconnectSignaled = true;
          this.emit('disconnected', reason);
        }
        if (this.failCount % 120 === 0) {
          log.debug(`[SSCClient] ${this.ip}:${this.port} still unreachable (${Math.round(this.failCount * 500 / 1000)}s)`);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  // Generic write operation (e.g. path = 'rx1/mute', value = true)
  async sendControl(path: string, value: any): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const cleanPath = path.startsWith('/') ? path.slice(1) : path;
      const scheme = this.activeUrl!.startsWith('https') ? 'https' : 'http';
      let controlUrl: string;
      if (this.isSSCv2) {
        controlUrl = `${this.baseUrl}/api/${cleanPath}`;
      } else if (this.activeUrl!.endsWith('/osc/')) {
        controlUrl = `${this.activeUrl}${cleanPath}`;
      } else {
        controlUrl = `${this.activeUrl}osc/${cleanPath}`;
      }
      await this.clientFor(scheme).put(controlUrl, { value });
      return true;
    } catch (err: any) {
      log.error(`[SSCClient] Failed to send control ${path} to ${this.ip}:`, err.message);
      return false;
    }
  }

  async identify(): Promise<boolean> {
    return this.sendControl('device/identity/flash', true);
  }

  async setMute(rxIndex: number, muted: boolean): Promise<boolean> {
    return this.sendControl(`rx${rxIndex}/mute`, muted);
  }

  async setGain(rxIndex: number, gain: number): Promise<boolean> {
    return this.sendControl(`rx${rxIndex}/audio/gain`, gain);
  }

  async setFrequency(rxIndex: number, frequencyHz: number): Promise<boolean> {
    return this.sendControl(`rx${rxIndex}/frequency`, frequencyHz);
  }

  async setNetwork(staticIp: string, subnet: string, gateway: string): Promise<boolean> {
    try {
      await this.sendControl('network/ip', staticIp);
      await this.sendControl('network/subnet', subnet);
      await this.sendControl('network/gateway', gateway);
      return true;
    } catch {
      return false;
    }
  }
}
