import { describe, it, expect, afterEach } from 'vitest';
import { FakeMeros } from './fakeMeros';
import { CloudClient } from './client';
import { CloudLink } from './link';
import { MemoryLinkStore } from './linkStore';
import { Documents, DocumentConflict, contentHash, canonicalJson } from './documents';
import { CloudConfig } from './config';
import { buildShowFile } from './showFile';

// Document sync, against the fake. The interesting behaviour is all in the 409:
// a push that would overwrite must not, and the operator has to be given enough
// to decide what happens instead.

let fake: FakeMeros | null = null;
afterEach(async () => { await fake?.close(); fake = null; });

async function harness() {
  fake = new FakeMeros();
  const baseUrl = await fake.listen();
  const config: CloudConfig = {
    baseUrl, clientId: 'rfdeck-server-test',
    browserClientId: null, packKeys: fake.packKeys(),
  };
  const client = new CloudClient(config);
  const store = new MemoryLinkStore();
  const link = new CloudLink(config, client, store);
  await link.start();
  // Wait for the fake to approve.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && link.pendingLink?.outcome === 'pending') {
    await new Promise(r => setTimeout(r, 20));
  }
  return { fake: fake!, docs: new Documents(client, link), link };
}

const show = (name = 'Wicked') => buildShowFile({
  id: 'show-1', name, environmentMode: 'THEATER', date: null, venue: null,
  notes: null, periodCount: 2, currentAct: 1,
  players: [{ realName: 'Ada', characterName: 'Elphaba', notes: '', sortIndex: 0,
              assignedChannelKey: 'dev-1:1', iemChannelKey: null,
              performerId: null, quickChanges: [] }],
  micCheck: [],
}, new Date('2026-10-02T09:00:00Z'));

describe('pushing and pulling a show', () => {
  it('creates version 1, then increments', async () => {
    const { docs } = await harness();
    const first = await docs.put('shows', 'show-1', show());
    expect(first.version).toBe(1);

    const second = await docs.put('shows', 'show-1', show('Wicked (rev)'), 1);
    expect(second.version).toBe(2);
  });

  it('round-trips the show file through the cloud unchanged', async () => {
    const { docs } = await harness();
    const sent = show();
    await docs.put('shows', 'show-1', sent);
    const got = await docs.get<typeof sent>('shows', 'show-1');
    expect(got.body).toEqual(sent);
    expect(got.version).toBe(1);
  });

  it('lists what is there, newest first', async () => {
    const { docs } = await harness();
    await docs.put('shows', 'show-1', show('One'));
    await new Promise(r => setTimeout(r, 5));
    await docs.put('shows', 'show-2', show('Two'));

    const listing = await docs.list('shows');
    expect(listing.documents.map(d => d.key)).toEqual(['show-2', 'show-1']);
    expect(listing.documents[0].head_version).toBe(1);
  });

  it('fetches an older version when asked', async () => {
    const { docs } = await harness();
    await docs.put('shows', 'show-1', show('First'));
    await docs.put('shows', 'show-1', show('Second'), 1);

    const old = await docs.get<any>('shows', 'show-1', 1);
    expect(old.body.show.name).toBe('First');
    const head = await docs.get<any>('shows', 'show-1');
    expect(head.body.show.name).toBe('Second');
  });

  it('reports the version history', async () => {
    const { docs } = await harness();
    await docs.put('shows', 'show-1', show('First'));
    await docs.put('shows', 'show-1', show('Second'), 1);
    const versions = await docs.versions('shows', 'show-1');
    expect(versions.map(v => v.version)).toEqual([1, 2]);
    expect(versions[0].content_hash).toBeTruthy();
  });
});

describe('the conflict, which is the whole point', () => {
  it('refuses a stale push and hands back the head', async () => {
    const { docs } = await harness();
    await docs.put('shows', 'show-1', show('Ours'));
    // Somebody else pushes from another machine.
    await docs.put('shows', 'show-1', show('Theirs'), 1);

    // We still think we are on version 1.
    try {
      await docs.put('shows', 'show-1', show('Ours, edited'), 1);
      expect.unreachable('should have conflicted');
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentConflict);
      const conflict = err as DocumentConflict;
      // Enough to offer a real choice rather than just saying "conflict".
      expect(conflict.headVersion).toBe(2);
      expect(conflict.headUpdatedAt).toBeTruthy();
      expect(conflict.headContentHash).toBeTruthy();
      expect(conflict.sameContent).toBe(false);
      expect(conflict.message).toMatch(/changed/);
    }
  });

  it('changes nothing on the cloud when it refuses', async () => {
    const { docs } = await harness();
    await docs.put('shows', 'show-1', show('Ours'));
    await docs.put('shows', 'show-1', show('Theirs'), 1);
    await docs.put('shows', 'show-1', show('Ours, edited'), 1).catch(() => {});

    const head = await docs.get<any>('shows', 'show-1');
    expect(head.version).toBe(2);
    expect(head.body.show.name).toBe('Theirs');
  });

  it('recognises a non-conflict: the same show pushed twice', async () => {
    // Two machines with the same show. There is nothing for an operator to
    // arbitrate, and asking them to is how they learn to click through dialogs.
    const { docs } = await harness();
    const identical = show('Same');
    await docs.put('shows', 'show-1', identical);
    await docs.put('shows', 'show-1', identical, 1);

    try {
      await docs.put('shows', 'show-1', identical, 1);
      expect.unreachable('should have conflicted');
    } catch (err) {
      const conflict = err as DocumentConflict;
      expect(conflict.sameContent).toBe(true);
      expect(conflict.message).toMatch(/already has this exact version/);
    }
  });

  it('treats creating an existing key as a conflict, not an overwrite', async () => {
    const { docs } = await harness();
    await docs.put('shows', 'show-1', show('Existing'));
    await expect(docs.put('shows', 'show-1', show('New')))
      .rejects.toBeInstanceOf(DocumentConflict);
  });
});

describe('guards', () => {
  it('refuses an oversized document locally, with a message that says what it is', async () => {
    const { docs, fake } = await harness();
    const huge = { showFile: 1, show: { name: 'x' }, filler: 'y'.repeat(1_100_000) };
    await expect(docs.put('shows', 'big', huge)).rejects.toThrowError(/over the 1 MB limit/);
    // Not even attempted: there is no point spending a venue's uplink on it.
    expect(fake.requests.some(r => r.path.includes('/v1/docs/'))).toBe(false);
  });

  it('drops a deleted key from the listing, and a later push revives it', async () => {
    const { docs } = await harness();
    await docs.put('shows', 'show-1', show());
    await docs.remove('shows', 'show-1');
    expect((await docs.list('shows')).documents).toHaveLength(0);

    // Pushing *is* the restore, and the version line continues rather than resetting.
    const revived = await docs.put('shows', 'show-1', show('Back'), 1);
    expect(revived.version).toBe(2);
    expect((await docs.list('shows')).documents).toHaveLength(1);
  });
});

describe('the canonical hash', () => {
  it('matches what the server computed for the same body', async () => {
    // If these ever disagree the benign-conflict check silently stops working and
    // operators get asked to resolve conflicts that are not conflicts.
    const { docs } = await harness();
    const body = show();
    const put = await docs.put('shows', 'show-1', body);
    expect(put.content_hash).toBe(contentHash(body));
  });

  it('sorts object keys recursively, so key order cannot change the hash', () => {
    // The whole point of canonicalising. Meros used to hash its own re-encoding
    // of whatever arrived, which no client could reproduce.
    const a = { b: 1, a: { d: 2, c: [1, 2] } };
    const z = { a: { c: [1, 2], d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(z));
    expect(contentHash(a)).toBe(contentHash(z));
    expect(canonicalJson(a)).toBe('{"a":{"c":[1,2],"d":2},"b":1}');
  });

  it('leaves array order alone, because array order is meaningful', () => {
    expect(contentHash({ xs: [1, 2, 3] })).not.toBe(contentHash({ xs: [3, 2, 1] }));
    expect(canonicalJson({ xs: [{ b: 1, a: 2 }] })).toBe('{"xs":[{"a":2,"b":1}]}');
  });

  it('emits no whitespace, unescaped slashes and unescaped unicode', () => {
    // Matching PHP's JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE.
    expect(canonicalJson({ url: 'https://meros.co/link', who: 'Renée Fleming' }))
      .toBe('{"url":"https://meros.co/link","who":"Renée Fleming"}');
  });

  it('is stable across nesting depth and null', () => {
    const deep = { z: { y: { x: [{ b: null, a: 1 }] } } };
    expect(canonicalJson(deep)).toBe('{"z":{"y":{"x":[{"a":1,"b":null}]}}}');
  });
});

describe('the conflict decision stays on the version', () => {
  it('reports a real conflict even when we cannot compute a matching hash', async () => {
    // A hash we computed ourselves could be wrong; the integer version cannot.
    // So a 409 is a conflict regardless of what the hashes say, and `sameContent`
    // only ever downgrades the prompt.
    const { docs } = await harness();
    await docs.put('shows', 'show-1', show('Ours'));
    await docs.put('shows', 'show-1', show('Theirs'), 1);
    try {
      await docs.put('shows', 'show-1', show('Ours, edited'), 1);
      expect.unreachable('should have conflicted');
    } catch (err) {
      const conflict = err as DocumentConflict;
      expect(conflict.headVersion).toBe(2);
      expect(conflict.sameContent).toBe(false);
    }
  });
});
