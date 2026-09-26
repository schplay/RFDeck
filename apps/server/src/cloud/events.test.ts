import { describe, it, expect, afterEach } from 'vitest';
import { FakeMeros } from './fakeMeros';
import { CloudClient } from './client';
import { CloudLink } from './link';
import { MemoryLinkStore } from './linkStore';
import { Events, ulid } from './events';
import { CloudConfig } from './config';

// The event stream. Most of these are about the promise that observability is
// never load-bearing: with no collector, or a broken one, the application must
// behave exactly as it does today.

let fake: FakeMeros | null = null;
afterEach(async () => { await fake?.close(); fake = null; });

async function harness() {
  fake = new FakeMeros();
  const baseUrl = await fake.listen();
  const config: CloudConfig = {
    baseUrl, clientId: 'rfdeck-server-test', browserClientId: null,
    packKeys: fake.packKeys(),
  };
  const client = new CloudClient(config);
  const link = new CloudLink(config, client, new MemoryLinkStore());
  await link.start();
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && link.pendingLink?.outcome === 'pending') {
    await new Promise(r => setTimeout(r, 20));
  }
  const events = new Events(client, link, 'instance-abc', '1.2.3', 'server');
  return { fake: fake!, events, baseUrl };
}

const dropout = () => ({
  type: 'rfdeck.channel.dropped_out' as const,
  severity: 'warning' as const,
  subject: { kind: 'channel', id: 'dev-1:1', name: 'Handheld 4' },
  attrs: { rfLevelA: 12, rfLevelB: 9 },
});

describe('the envelope', () => {
  it('fills in everything the spec requires', async () => {
    const { fake, events, baseUrl } = await harness();
    events.setCollectors([{ name: 'meros', url: baseUrl }]);
    events.emit(dropout());
    await events.flush();

    const [stored] = [...fake.events.values()];
    expect(stored.envelope).toBe(1);
    expect(stored.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(stored.occurred_at).toMatch(/Z$/);
    expect(stored.source).toMatchObject({
      product: 'rfdeck', version: '1.2.3', instance: 'instance-abc', edition: 'server',
    });
    expect(stored.type).toBe('rfdeck.channel.dropped_out');
    expect(stored.severity).toBe('warning');
    expect(stored.subject).toEqual({ kind: 'channel', id: 'dev-1:1', name: 'Handheld 4' });
  });

  it('puts product data in attrs, never as a new top-level key', async () => {
    // The envelope keys are frozen; everything RFDeck-specific lives in attrs.
    const { fake, events, baseUrl } = await harness();
    events.setCollectors([{ name: 'meros', url: baseUrl }]);
    events.emit(dropout());
    await events.flush();

    const [stored] = [...fake.events.values()];
    expect(stored.attrs).toEqual({ rfLevelA: 12, rfLevelB: 9 });
    expect(Object.keys(stored).sort()).toEqual(
      ['attrs', 'envelope', 'id', 'occurred_at', 'seq', 'severity', 'source', 'subject', 'type'],
    );
  });

  it('numbers events monotonically, so a collector can spot a gap', async () => {
    const { fake, events, baseUrl } = await harness();
    events.setCollectors([{ name: 'meros', url: baseUrl }]);
    events.emit(dropout());
    events.emit(dropout());
    events.emit(dropout());
    await events.flush();

    const seqs = [...fake.events.values()].map(e => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('generates sortable unique ids', () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => ulid())).size).toBe(200);
  });
});

describe('observability is never load-bearing', () => {
  it('queues nothing at all when there are no collectors', () => {
    // "Behaves exactly as it does today" has to mean no accumulation either, or a
    // rig that will never send anything slowly fills memory.
    const events = new Events(null as any, null as any, 'i', '1', 'server');
    for (let i = 0; i < 1000; i++) events.emit(dropout());
    expect(events.queued).toBe(0);
  });

  it('never throws, whatever it is handed', async () => {
    const { events, baseUrl } = await harness();
    events.setCollectors([{ name: 'meros', url: baseUrl }]);
    const circular: any = { self: null };
    circular.self = circular;
    // Every caller is on a hot path — telemetry, dropout detection, a battery
    // threshold — so an exception here would matter far more than a lost event.
    expect(() => events.emit({ ...dropout(), attrs: circular })).not.toThrow();
    expect(() => events.emit({ type: '', severity: 'info' } as any)).not.toThrow();
  });

  it('survives a collector that is simply not there', async () => {
    const { events } = await harness();
    events.setCollectors([{ name: 'gone', url: 'http://127.0.0.1:1', token: null }]);
    events.emit(dropout());
    await expect(events.flush()).resolves.toBeTruthy();
    // Kept for a later attempt rather than lost to a flaky uplink.
    expect(events.queued).toBe(1);
  });

  it('bounds the queue rather than growing without limit', () => {
    const events = new Events(null as any, null as any, 'i', '1', 'server');
    events.setCollectors([{ name: 'gone', url: 'http://127.0.0.1:1', token: null }]);
    for (let i = 0; i < 6000; i++) events.emit(dropout());
    // A rig can be offline for a week. Running out of memory is a far worse
    // failure for a monitoring product than losing the oldest history.
    expect(events.queued).toBeLessThanOrEqual(5000);
    expect(events.droppedCount).toBeGreaterThan(0);
    events.stop();
  });

  it('trims oversized attrs and keeps the event, rather than losing the record', async () => {
    // The better trade: a dropout with truncated detail is still a dropout worth
    // knowing about, whereas dropping the event loses the fact that it happened.
    const { fake, events, baseUrl } = await harness();
    events.setCollectors([{ name: 'meros', url: baseUrl }]);
    events.emit({ ...dropout(), attrs: { keep: 'small', blob: 'x'.repeat(200_000) } });
    expect(events.queued).toBe(1);
    await events.flush();

    const [stored] = [...fake.events.values()];
    expect(stored.attrs.keep).toBe('small');
    // Marked, so a reader knows detail is missing rather than assuming it was
    // never there.
    expect(stored.attrs._truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(stored.attrs), 'utf8')).toBeLessThanOrEqual(16 * 1024);
  });

  it('drops an event that is oversized where trimming cannot help', () => {
    // Attrs can be trimmed; a caller passing a megabyte of subject name is a bug,
    // and the collector would reject it per-event anyway. Not worth a venue's
    // uplink.
    const events = new Events(null as any, null as any, 'i', '1', 'server');
    events.setCollectors([{ name: 'x', url: 'http://127.0.0.1:1', token: null }]);
    events.emit({
      ...dropout(),
      attrs: undefined,
      subject: { kind: 'channel', id: 'x', name: 'y'.repeat(100_000) },
    });
    expect(events.queued).toBe(0);
    expect(events.droppedCount).toBe(1);
    events.stop();
  });
});

describe('delivery', () => {
  it('dedupes a resent batch on (source.instance, id)', async () => {
    // The point of the emitter-generated ULID: a flush that half-succeeded and
    // was retried must not double-count.
    const { fake, events, baseUrl } = await harness();
    events.setCollectors([{ name: 'meros', url: baseUrl }]);
    events.emit(dropout());
    const first = await events.flush();
    expect(first.accepted).toBe(1);

    // Re-send the same event by hand.
    const [stored] = [...fake.events.values()];
    const token = (fake.requests.find(r => r.path === '/v1/events')!.auth ?? '').replace('Bearer ', '');
    const res = await fetch(`${baseUrl}/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify([stored]),
    });
    expect(await res.json()).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it('batches rather than sending one request per event', async () => {
    const { fake, events, baseUrl } = await harness();
    events.setCollectors([{ name: 'meros', url: baseUrl }]);
    for (let i = 0; i < 50; i++) events.emit(dropout());
    await events.flush();
    expect(fake.requests.filter(r => r.path === '/v1/events')).toHaveLength(1);
    expect(fake.events.size).toBe(50);
  });

  it('sends to every collector, so a local one and the cloud both get it', async () => {
    const { fake, events, baseUrl } = await harness();
    // One emitter, a list of collectors — which is what makes adding an Imperio
    // later configuration rather than a rewrite.
    events.setCollectors([
      { name: 'meros', url: baseUrl },
      { name: 'imperio', url: baseUrl },
    ]);
    events.emit(dropout());
    await events.flush();
    expect(fake.requests.filter(r => r.path === '/v1/events')).toHaveLength(2);
  });

  it('keeps events when every collector fails, and clears them when one works', async () => {
    const { events, baseUrl } = await harness();
    events.setCollectors([{ name: 'gone', url: 'http://127.0.0.1:1', token: null }]);
    events.emit(dropout());
    await events.flush();
    expect(events.queued).toBe(1);

    events.setCollectors([{ name: 'meros', url: baseUrl }]);
    await events.flush();
    expect(events.queued).toBe(0);
  });
});
