import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// RFDeck's cloud client, driven through the real meros-client helper against
// RFDeck's fake Meros.
//
// The helper has its own tests for the protocol (token rotation, PKCE, the
// id_token checks, ETag, the event envelope). These are for RFDeck's side:
// that each piece of RFDeck asks the helper the right question and does the
// right thing with the answer. The database is replaced so nothing here writes
// to a real one.

const db = vi.hoisted(() => ({
  settings: { id: 1, cloudLinkedAt: null as Date | null, eventToCloud: false },
  devices: [] as any[],
}));
vi.mock('../db', () => ({
  prisma: {
    settings: {
      findFirst: async () => db.settings,
      create: async () => db.settings,
      update: async ({ data }: any) => Object.assign(db.settings, data),
    },
    inventoryDevice: { findMany: async () => db.devices },
  },
}));

import { FakeMeros, FakeMerosOptions } from './fakeMeros';
import { CloudConfig } from './config';
import { MerosClient, resolveMerosClientBinary } from './merosClient';
import { CloudLink } from './link';
import { Entitlements } from './entitlements';
import { Documents, DocumentConflict, DocumentNotFound, contentHash } from './documents';
import { buildShowFile } from './showFile';
import { InventorySync, InventoryScopeMissing } from './inventorySync';
import { Events } from './events';
import { CloudUserLogin } from './cloudUser';
import { MemoryCloudUserStore } from './cloudUserStore';

const BIN = resolveMerosClientBinary();
if (!fs.existsSync(BIN)) {
  throw new Error(
    `The meros-client helper is not at ${BIN}. Build it with ` +
    '`pnpm --filter @rfdeck/server build:meros-client`, or set MEROS_CLIENT_BIN.',
  );
}

let fake: FakeMeros;
let dir: string;
let config: CloudConfig;
let meros: MerosClient;

async function setup(options: FakeMerosOptions = {}) {
  fake = new FakeMeros(options);
  const baseUrl = await fake.listen();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfdeck-meros-'));
  config = {
    baseUrl, clientId: 'rfdeck-server', browserClientId: null,
    cloudUserClientId: 'rfdeck-cloud-user', packKeys: fake.packKeys(),
  };
  meros = new MerosClient(config, BIN, { stateDir: path.join(dir, 'meros'), keyFile: path.join(dir, 'meros.key') });
}

async function linked(): Promise<CloudLink> {
  const link = new CloudLink(config, meros);
  await link.start();
  for (let i = 0; i < 150 && link.pendingLink?.outcome === 'pending'; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  expect(link.pendingLink?.detail ?? link.pendingLink?.outcome).toBe('linked');
  return link;
}

beforeEach(() => {
  db.settings = { id: 1, cloudLinkedAt: null, eventToCloud: false };
  db.devices = [];
});

afterEach(async () => {
  await fake?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the instance link', () => {
  it('links by device grant, and says so', async () => {
    await setup();
    const link = await linked();
    expect(await link.isLinked()).toBe(true);
    expect(db.settings.cloudLinkedAt).toBeInstanceOf(Date);
    expect(link.needsRelink).toBeNull();
  }, 30_000);

  it('reports a declined request', async () => {
    await setup({ deny: true });
    const link = new CloudLink(config, meros);
    await link.start();
    for (let i = 0; i < 150 && link.pendingLink?.outcome === 'pending'; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    expect(link.pendingLink?.outcome).toBe('denied');
    expect(await link.isLinked()).toBe(false);
  }, 30_000);

  it('unlinks with the client named, so Meros actually revokes', async () => {
    await setup();
    const link = await linked();
    await link.unlink();
    expect(await link.isLinked()).toBe(false);
    expect(db.settings.cloudLinkedAt).toBeNull();
    // Without client_id Meros answers 200 and revokes nothing.
    expect(fake.unidentifiedRevocations).toBe(0);
    expect(fake.accessRevocations + fake.refreshRevocations).toBeGreaterThan(0);
  }, 30_000);
});

describe('entitlements', () => {
  it('holds what the account has, from Meros\'s flat feature map', async () => {
    await setup({ features: ['rfdeck.spectrum', 'rfdeck.backup.config'] });
    const ent = new Entitlements(await linked());
    await ent.refresh();
    expect(await ent.holds('rfdeck.spectrum')).toBe(true);
    expect(await ent.holds('rfdeck.backup.config')).toBe(true);
    expect(await ent.holds('rfdeck.inventory')).toBe(false);
    expect(await ent.entitled('rfdeck.inventory')).toBe(false);
    expect(ent.snapshot().accountId).toBe('acct-fake-1');
  }, 30_000);

  it('keeps answering from the last answer when Meros is unreachable', async () => {
    await setup({ features: ['rfdeck.spectrum'] });
    const ent = new Entitlements(await linked());
    await ent.refresh();
    await fake.close();
    await ent.refresh();
    expect(await ent.holds('rfdeck.spectrum')).toBe(true);
    expect(ent.snapshot().lastError).toMatch(/unreachable/);
  }, 30_000);

  it('withholds everything once the grace after expiry has lapsed', async () => {
    await setup({ features: ['rfdeck.spectrum'], expiresAt: new Date(Date.now() - 31 * 86400_000).toISOString() });
    const ent = new Entitlements(await linked());
    await ent.refresh();
    expect(await ent.holds('rfdeck.spectrum')).toBe(false);
    expect(ent.snapshot().lapsed).toBe(true);
  }, 30_000);
});

describe('documents', () => {
  it('saves, reads back, and treats an identical copy as already current', async () => {
    await setup();
    const docs = new Documents(await linked());
    const first = await docs.put('shows', 's1', { name: 'Main', cast: ['a'] });
    expect(first).toMatchObject({ version: 1, unchanged: false });

    // Pushed again from a machine with no bookmark: the same content is not a conflict.
    const again = await docs.put('shows', 's1', { cast: ['a'], name: 'Main' });
    expect(again).toMatchObject({ version: 1, unchanged: true });

    const got = await docs.get('shows', 's1');
    expect(got).toMatchObject({ version: 1, headVersion: 1, body: { name: 'Main', cast: ['a'] } });
    expect(got.contentHash).toBe(first.content_hash);

    const listing = await docs.list('shows');
    expect(listing.documents).toEqual([expect.objectContaining({ key: 's1', head_version: 1 })]);
  }, 30_000);

  it("agrees with RFDeck's own hash of a real show file", async () => {
    // RFDeck hashes its local copy to tell whether a show still matches what it
    // last synced. If that ever disagreed with Meros, every show would look edited.
    await setup();
    const docs = new Documents(await linked());
    const body = buildShowFile({
      id: 'show-1', name: 'Wicked', environmentMode: 'THEATER', date: null, venue: null,
      notes: null, periodCount: 2, currentAct: 1,
      players: [{ realName: 'Renée', characterName: 'Elphaba', notes: 'a/b', sortIndex: 0,
                  assignedChannelKey: 'dev-1:1', iemChannelKey: null, performerId: null, quickChanges: [] }],
      micCheck: [],
    }, new Date('2026-10-02T09:00:00Z'));
    const put = await docs.put('shows', 'show-1', body);
    expect(put.content_hash).toBe(contentHash(body));
    expect((await docs.get('shows', 'show-1')).contentHash).toBe(contentHash(body));
  }, 30_000);

  it('refuses a stale push with the head version, and tells "never saved" apart', async () => {
    await setup();
    const docs = new Documents(await linked());
    await docs.put('shows', 's1', { name: 'A' });
    await docs.put('shows', 's1', { name: 'B' }, 1);
    const stale = await docs.put('shows', 's1', { name: 'C' }, 1).catch(e => e);
    expect(stale).toBeInstanceOf(DocumentConflict);
    expect(stale.headVersion).toBe(2);

    await expect(docs.get('shows', 'never-saved')).rejects.toBeInstanceOf(DocumentNotFound);
  }, 30_000);
});

describe('the inventory listing', () => {
  it('pushes this install\'s devices and reads the listing back', async () => {
    await setup();
    db.devices = [{ id: 'd1', name: 'Rack 1', manufacturer: 'Shure', model: 'AD4D', deviceType: 'input', active: true }];
    const inv = new InventorySync(await linked());
    expect(await inv.push()).toMatchObject({ count: 1 });
    const listing = await inv.fetch();
    expect(listing.count).toBe(1);
    expect(listing.devices[0]).toMatchObject({ id: 'd1', name: 'Rack 1' });
  }, 30_000);

  it('says "link again" for a token without the inventory scope', async () => {
    await setup({ withholdInventoryScope: true });
    const inv = new InventorySync(await linked());
    await expect(inv.push()).rejects.toBeInstanceOf(InventoryScopeMissing);
  }, 30_000);
});

describe('the event stream', () => {
  it('delivers what RFDeck emits, in Meros\'s envelope', async () => {
    await setup();
    const events = new Events(await linked(), 'server');
    events.setEnabled(true);
    events.emit({ type: 'rfdeck.rf.dropout', severity: 'warning', subject: { kind: 'channel', id: 'c1', name: 'Vocal' } });
    await events.flush();
    const sent = [...fake.events.values()];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'rfdeck.rf.dropout', severity: 'warning',
      subject: { kind: 'channel', id: 'c1' }, source: { product: 'rfdeck' },
    });
    expect(events.queued).toBe(0);
  }, 30_000);

  it('emits nothing at all while the stream is off', async () => {
    await setup();
    const events = new Events(await linked(), 'server');
    events.emit({ type: 'rfdeck.rf.dropout', severity: 'warning' });
    await events.flush();
    expect(fake.events.size).toBe(0);
    expect(events.queued).toBe(0);
  }, 30_000);
});

describe('signing a cloud user in from a console', () => {
  it('redeems the login token with RFDeck\'s own verifier, and signs out with the client named', async () => {
    await setup();
    const login = new CloudUserLogin(config, meros, new MemoryCloudUserStore());
    const begun = await login.begin();
    expect(begun.codeChallengeMethod).toBe('S256');

    // Standing in for the console: mint the token with RFDeck's challenge and nonce.
    const token = fake.mintLoginToken({
      codeChallenge: begun.codeChallenge, nonce: begun.nonce, clientId: 'rfdeck-cloud-user',
      sub: 'user-42', name: 'Ada', email: 'ada@example.test',
    });
    const session = await login.complete(begun.requestId, token);
    expect(session).toMatchObject({
      signedIn: true, replacedPrevious: false, signedInVia: 'manifold',
      user: { sub: 'user-42', name: 'Ada', email: 'ada@example.test' },
    });

    await login.signOut();
    expect((await login.session()).signedIn).toBe(false);
    expect(fake.unidentifiedRevocations).toBe(0);
    expect(fake.accessRevocations + fake.refreshRevocations).toBeGreaterThan(0);
  }, 30_000);

  it('refuses a request that was not begun here', async () => {
    await setup();
    const login = new CloudUserLogin(config, meros, new MemoryCloudUserStore());
    await expect(login.complete('not-a-request', 'x')).rejects.toMatchObject({ status: 404, code: 'unknown_request' });
  }, 30_000);
});
