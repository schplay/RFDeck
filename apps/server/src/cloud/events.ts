import { log } from '../logger';
import { CloudLink } from './link';

/**
 * The event stream: what happened on this rig, sent to Meros Cloud, where
 * alerts are configured over it.
 *
 * The envelope, ids (ULIDs, so a resent batch is recognized as duplicates), the
 * sequence, the size limits and the outbox for undelivered events are the
 * meros-client helper's (`events.send`). What stays here is the promise to the
 * rest of RFDeck: emitting is synchronous, never throws, and costs nothing when
 * the stream is off, because every caller is on a path where an exception would
 * matter far more than a lost event.
 *
 * Events are gathered for a moment and sent together, so a rack losing thirty
 * channels at once is one call rather than thirty.
 */

export type Severity = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

export interface EmitInput {
  type: string;
  severity: Severity;
  subject?: { kind: string; id: string; name?: string };
  actor?: { kind: 'user' | 'system' | 'device' | 'external'; id?: string; name?: string };
  attrs?: Record<string, unknown>;
  trace?: string;
}

/**
 * How long events are gathered before sending. Short, because the helper
 * stamps each event's time when it is sent.
 */
const GATHER_MS = 2_000;
/** Events held here while a send is in flight or the uplink is down. The helper keeps its own outbox. */
const MAX_BUFFER = 10_000;

export class Events {
  private buffer: EmitInput[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  private enabled = false;
  private dropped = 0;
  /** What the helper last said is waiting in its outbox. */
  private outbox = 0;
  private failures = 0;

  constructor(
    private readonly link: CloudLink,
    private readonly edition: 'desktop' | 'server' | 'appliance' = 'server',
  ) {}

  /** Send to Meros Cloud, or stop and hold nothing. */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      // Nothing will be sent, so nothing accumulates. This is what "behaves
      // exactly as it does today" has to mean in practice.
      this.buffer = [];
      this.stop();
    }
  }

  get queued(): number {
    return this.buffer.length + this.outbox;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Record that something happened. Synchronous, non-throwing, and cheap. */
  emit(input: EmitInput): void {
    try {
      if (!this.enabled) return;
      if (this.buffer.length >= MAX_BUFFER) {
        // Drop the oldest. A monitoring product that runs out of memory because
        // the cloud was down has failed much worse than one that loses history.
        this.buffer.shift();
        this.dropped += 1;
      }
      this.buffer.push(input);
      if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, GATHER_MS);
    } catch {
      // Nothing about emitting may reach the caller.
      this.dropped += 1;
    }
  }

  /**
   * Hand what is gathered to the helper, which delivers it and keeps whatever
   * does not get through for the next send, under the same ids.
   */
  async flush(): Promise<void> {
    if (!this.enabled || this.sending) return;
    const batch = this.buffer;
    if (batch.length === 0 && this.outbox === 0) return;
    this.buffer = [];
    this.sending = true;
    try {
      // With nothing new, this is a retry of the helper's outbox.
      const res = await this.link.run<{ pending?: number; rejected?: number; failed?: number }>(
        batch.length ? 'events.send' : 'events.flush', {
        events: batch.map(e => ({
          type: e.type, severity: e.severity,
          ...(e.subject ? { subject: e.subject } : {}),
          ...(e.actor ? { actor: e.actor } : {}),
          ...(e.attrs ? { attrs: e.attrs } : {}),
          ...(e.trace ? { trace: e.trace } : {}),
        })),
        edition: this.edition,
      });
      this.outbox = Number(res.pending ?? 0);
      this.failures = 0;
      if (res.rejected) {
        // Per-event rejections are permanent: a malformed envelope will not
        // become valid on a retry.
        log.warn(`[Cloud] Meros rejected ${res.rejected} event(s) as malformed; they will not be retried`);
      }
    } catch (err) {
      // The helper could not take them (no link, or the helper failing): hold
      // them for the next attempt rather than lose a dropout record.
      this.buffer = batch.concat(this.buffer).slice(-MAX_BUFFER);
      this.failures += 1;
      // Logged once, then every tenth time: a venue with no uplink should not
      // fill the journal with the same line.
      if (this.failures === 1 || this.failures % 10 === 0) {
        log.warn(`[Cloud] Sending events failed (${this.failures}): ${(err as Error).message}`);
      }
      if (!this.timer && this.enabled) {
        this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 30_000);
      }
    } finally {
      this.sending = false;
    }
    if (!this.timer && this.enabled) {
      if (this.buffer.length > 0) {
        this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, GATHER_MS);
      } else if (this.outbox > 0) {
        // Undelivered events wait in the helper's outbox; try them again in a
        // minute even if nothing new happens.
        this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 60_000);
      }
    }
  }
}
