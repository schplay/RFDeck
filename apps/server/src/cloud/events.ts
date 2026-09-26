import crypto from 'crypto';
import { log } from '../logger';
import { CloudClient, CloudOffline, CloudRefused } from './client';
import { CloudLink } from './link';

/**
 * RFDeck's event stream.
 *
 * Events are the whole record of what the application does, not a curated set of
 * alert-worthy moments. Alerts are rules the user configures in the cloud *over*
 * this stream, so there is nothing to post to an alert endpoint and nothing here
 * to gate — RFDeck's job is to emit good events.
 *
 * ── Never load-bearing ──────────────────────────────────────────────────────
 *
 * The envelope spec puts it plainly: a product configured with zero collectors
 * behaves exactly as it does today — no network attempts, no degradation. That is
 * the same promise as RFDeck's first principle, so it is enforced here rather
 * than trusted:
 *
 *   • `emit()` never throws and never returns a rejected promise. Every caller is
 *     on a hot path — telemetry, dropout detection, a battery threshold — and a
 *     dropout that goes unreported is vastly better than one that takes the
 *     dashboard down.
 *   • Nothing blocks on the network. Events queue in memory and flush on a timer.
 *   • With no collectors the queue is never even filled, so there is no slow leak
 *     on an install that will never send anything.
 *
 * A collector is anything that accepts the binding: the Meros cloud ingest, a
 * local Imperio, or a script. They are a list rather than a single cloud URL, so
 * adding one later is configuration rather than a rewrite.
 */

export type Severity = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

export interface MerosEvent {
  envelope: 1;
  id: string;
  occurred_at: string;
  seq?: number;
  source: {
    product: 'rfdeck';
    version: string;
    instance: string;
    edition?: 'desktop' | 'server' | 'appliance';
  };
  type: string;
  severity: Severity;
  subject?: { kind: string; id: string; name?: string };
  actor?: { kind: 'user' | 'system' | 'device' | 'external'; id?: string; name?: string };
  attrs?: Record<string, unknown>;
  trace?: string;
}

/** What a caller provides. Everything the envelope requires is filled in here. */
export interface EmitInput {
  type: string;
  severity: Severity;
  subject?: { kind: string; id: string; name?: string };
  actor?: MerosEvent['actor'];
  attrs?: Record<string, unknown>;
  trace?: string;
  occurredAt?: Date;
}

export interface Collector {
  /** For logs, and for telling two collectors apart. */
  name: string;
  /** Base URL; `/v1/events` is appended. */
  url: string;
  /** Bearer token, or null to use the instance link's access token. */
  token?: string | null;
}

/** Meros's cap. */
const MAX_BATCH = 500;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_ATTRS_BYTES = 16 * 1024;
/**
 * How many events to hold when a collector is unreachable.
 *
 * A bound rather than a best effort: a rig can be offline for a week, and an
 * unbounded queue would turn "the cloud is down" into "the server ran out of
 * memory", which is a much worse failure for a monitoring product.
 */
const MAX_QUEUE = 5_000;
const FLUSH_INTERVAL_MS = 10_000;

/**
 * A ULID, which is what the envelope asks for.
 *
 * Lexicographically sortable by time, and the collector's idempotency key — so a
 * batch retried after a link flap is deduped rather than double-counted.
 */
export function ulid(now: number = Date.now()): string {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford base32
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const random = crypto.randomBytes(16);
  let tail = '';
  for (let i = 0; i < 16; i++) tail += ALPHABET[random[i] % 32];
  return time + tail;
}

export class Events {
  private queue: MerosEvent[] = [];
  private collectors: Collector[] = [];
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private dropped = 0;
  /** Per collector, so one being down does not starve another. */
  private failures = new Map<string, number>();

  constructor(
    private readonly client: CloudClient,
    private readonly link: CloudLink,
    private readonly instanceId: string,
    private readonly version: string,
    private readonly edition: MerosEvent['source']['edition'] = 'server',
    /** Starting sequence number, so a restart does not reuse numbers. */
    startingSeq = 0,
  ) {
    this.seq = startingSeq;
  }

  /** Replace the collector list. No collectors means nothing is queued at all. */
  setCollectors(collectors: Collector[]) {
    this.collectors = collectors;
    if (collectors.length === 0) {
      // Nothing will ever be sent, so do not accumulate. This is what "behaves
      // exactly as it does today" has to mean in practice.
      this.queue = [];
      this.stop();
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
      // Not unref'd: a pending flush should get its chance before exit, and the
      // interval is long enough that it costs nothing.
    }
    log.info(`[Cloud] Events: ${collectors.map(c => c.name).join(', ')}`);
  }

  get collectorCount(): number {
    return this.collectors.length;
  }

  get queued(): number {
    return this.queue.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Record that something happened.
   *
   * Synchronous, non-throwing, and cheap: it builds an object and pushes it. Every
   * caller is on a path where an exception would matter far more than a lost event.
   */
  emit(input: EmitInput): void {
    try {
      if (this.collectors.length === 0) return;

      const event: MerosEvent = {
        envelope: 1,
        id: ulid(),
        occurred_at: (input.occurredAt ?? new Date()).toISOString(),
        seq: ++this.seq,
        source: {
          product: 'rfdeck',
          version: this.version,
          instance: this.instanceId,
          edition: this.edition,
        },
        type: input.type,
        severity: input.severity,
      };
      if (input.subject) event.subject = input.subject;
      if (input.actor) event.actor = input.actor;
      if (input.trace) event.trace = input.trace;
      if (input.attrs) event.attrs = Events.fitAttrs(input.attrs);

      // Oversized events are dropped rather than sent to be rejected: the
      // collector would refuse them per-event anyway, and a 64 KiB event is a bug
      // in a caller rather than something to spend a venue's uplink on.
      if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) {
        this.dropped += 1;
        log.warn(`[Cloud] Event ${input.type} exceeds 64 KiB and was dropped`);
        return;
      }

      if (this.queue.length >= MAX_QUEUE) {
        // Drop the oldest. A monitoring product that runs out of memory because
        // the cloud was down has failed much worse than one that loses history.
        this.queue.shift();
        this.dropped += 1;
      }
      this.queue.push(event);
    } catch (err) {
      // Nothing about emitting may reach the caller.
      this.dropped += 1;
    }
  }

  /** Trim `attrs` to the envelope's 16 KiB, keeping as many keys as fit. */
  private static fitAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
    if (Buffer.byteLength(JSON.stringify(attrs), 'utf8') <= MAX_ATTRS_BYTES) return attrs;
    const fitted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attrs)) {
      const candidate = { ...fitted, [key]: value };
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_ATTRS_BYTES) break;
      fitted[key] = value;
    }
    fitted._truncated = true;
    return fitted;
  }

  /**
   * Send what is queued, to every collector.
   *
   * Events are removed from the queue only once a collector has accepted them. A
   * transport failure puts them back, because losing a dropout record to a flaky
   * uplink defeats the point of recording it — and the ULID id means a resend is
   * deduped rather than duplicated.
   */
  async flush(): Promise<{ accepted: number; retried: number }> {
    if (this.collectors.length === 0 || this.queue.length === 0) {
      return { accepted: 0, retried: 0 };
    }
    const batch = this.queue.slice(0, MAX_BATCH);
    let accepted = 0;
    let retried = 0;

    for (const collector of this.collectors) {
      try {
        const token = collector.token === undefined
          ? await this.link.token()
          : collector.token ?? undefined;

        const result = await this.client.json<{ accepted?: number; rejected?: number; errors?: unknown[] }>(
          'POST', `${collector.url.replace(/\/+$/, '')}/v1/events`,
          { token, body: batch },
        );
        accepted += result?.accepted ?? batch.length;
        this.failures.delete(collector.name);
        if (result?.rejected) {
          // Per-event rejections are permanent — a malformed envelope will not
          // become valid on a retry — so they are logged and dropped, not requeued.
          log.warn(
            `[Cloud] ${collector.name} rejected ${result.rejected} event(s) as malformed; ` +
            `they will not be retried`,
          );
        }
      } catch (err) {
        retried += 1;
        const count = (this.failures.get(collector.name) ?? 0) + 1;
        this.failures.set(collector.name, count);
        // Logged once, then only every tenth attempt: a venue with no uplink
        // should not fill the journal with the same line every ten seconds.
        if (count === 1 || count % 10 === 0) {
          this.client.logOnce(`Sending events to ${collector.name} failed (${count})`, err);
        }
        if (err instanceof CloudRefused && err.status === 403) {
          // Not entitled, or the scope was not granted. Retrying cannot help.
          log.warn(`[Cloud] ${collector.name} refused the event stream: ${err.message}`);
        }
      }
    }

    // Dropped from the queue when at least one collector took them. Holding them
    // for a collector that is down would mean a working one receiving everything
    // twice once it recovered.
    if (accepted > 0 || retried < this.collectors.length) {
      this.queue = this.queue.slice(batch.length);
    }
    return { accepted, retried };
  }
}
