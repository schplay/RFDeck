import { describe, it, expect } from 'vitest';
import { buildShowFile, parseShowFile, showFileKey, ShowFileError, SHOW_FILE_VERSION } from './showFile';

// A show file has one job: survive a round trip. Everything here is in service of
// that, because the failure it guards against is an operator pulling last week's
// show and finding a performer's quick change missing.

const row = () => ({
  id: 'b0a1c2d3-0000-4000-8000-000000000001',
  name: 'Wicked',
  environmentMode: 'THEATER',
  date: '2026-10-01',
  venue: 'Apollo Victoria',
  notes: 'two casts',
  periodCount: 2,
  currentAct: 1,
  players: [
    {
      performerId: 'p-elphaba', realName: 'Ada Lovelace', characterName: 'Elphaba',
      notes: 'wig, then hat', assignedChannelKey: 'dev-1:1', iemChannelKey: 'dev-2:1',
      sortIndex: 0,
      quickChanges: [
        { act: 1, outCue: 'end of sc. 3', inCue: 'top of sc. 5', notes: 'pack to SR', sortIndex: 0 },
        { act: 2, outCue: 'defying', inCue: 'no good deed', notes: '', sortIndex: 1 },
      ],
    },
    {
      performerId: null, realName: 'Grace Hopper', characterName: 'Glinda',
      notes: '', assignedChannelKey: 'dev-1:2', iemChannelKey: null, sortIndex: 1,
      quickChanges: [],
    },
  ],
  micCheck: [
    { act: 2, channelKey: 'dev-1:2', checked: false, checkedAt: null, checkedBy: null, notes: null },
    { act: 1, channelKey: 'dev-1:1', checked: true, checkedAt: new Date('2026-10-01T18:05:00Z'), checkedBy: 'A2', notes: 'buzz on 1' },
    { act: 1, channelKey: 'dev-1:2', checked: true, checkedAt: new Date('2026-10-01T18:06:00Z'), checkedBy: null, notes: null },
  ],
});

describe('buildShowFile', () => {
  it('carries the show, the cast, their channels and the mic check', () => {
    const file = buildShowFile(row(), new Date('2026-10-02T09:00:00Z'));
    expect(file.showFile).toBe(SHOW_FILE_VERSION);
    expect(file.show).toMatchObject({ name: 'Wicked', venue: 'Apollo Victoria', periodCount: 2 });
    expect(file.players).toHaveLength(2);
    expect(file.players[0]).toMatchObject({
      realName: 'Ada Lovelace', characterName: 'Elphaba',
      assignedChannelKey: 'dev-1:1', iemChannelKey: 'dev-2:1',
    });
    expect(file.players[0].quickChanges).toHaveLength(2);
    expect(file.micCheck).toHaveLength(3);
  });

  it('keeps the performer id so a shared roster re-links the same people', () => {
    const file = buildShowFile(row());
    expect(file.players[0].performerId).toBe('p-elphaba');
    // ...and the name alongside it, so a machine that does not know the roster
    // still gets a cast list rather than two blanks.
    expect(file.players[0].realName).toBe('Ada Lovelace');
  });

  it('orders everything, so the same show exports byte-identically', () => {
    // Document sync compares content hashes to tell a real conflict from the same
    // show pushed twice. Row order from Prisma is not guaranteed, so an unstable
    // order here would make every push look like a change.
    const shuffled = row();
    shuffled.micCheck.reverse();
    shuffled.players.reverse();
    shuffled.players.forEach((p: any) => p.quickChanges.reverse());

    const a = JSON.stringify(buildShowFile(row(), new Date('2026-10-02T09:00:00Z')));
    const b = JSON.stringify(buildShowFile(shuffled, new Date('2026-10-02T09:00:00Z')));
    expect(b).toBe(a);
  });

  it('contains nothing that is a property of a rig at a moment', () => {
    const json = JSON.stringify(buildShowFile(row()));
    for (const forbidden of ['rfLevel', 'battery', 'clip', 'audio', 'afLevel', 'password']) {
      expect(json.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('survives a row with nothing optional set', () => {
    const bare = {
      id: 'x', name: 'Rehearsal', environmentMode: 'THEATER',
      date: null, venue: null, notes: null, periodCount: 1, currentAct: 1,
      players: [], micCheck: [],
    };
    const file = buildShowFile(bare);
    expect(file.show.name).toBe('Rehearsal');
    expect(file.players).toEqual([]);
    expect(file.micCheck).toEqual([]);
  });
});

describe('the round trip', () => {
  it('build → parse → build is identical', () => {
    // The property the whole format exists for.
    const at = new Date('2026-10-02T09:00:00Z');
    const first = buildShowFile(row(), at);
    const parsed = parseShowFile(JSON.parse(JSON.stringify(first)));
    expect(parsed).toEqual(first);
  });
});

describe('parseShowFile', () => {
  it('refuses a file from a newer format rather than dropping what it cannot read', () => {
    const file: any = buildShowFile(row());
    file.showFile = SHOW_FILE_VERSION + 1;
    expect(() => parseShowFile(file)).toThrowError(/newer version/);
  });

  it('refuses something that is not a show file at all', () => {
    for (const bad of [null, 42, 'a show', {}, { showFile: 1 }, { showFile: 1, show: {} }]) {
      expect(() => parseShowFile(bad)).toThrowError(ShowFileError);
    }
  });

  it('coerces rubbish rather than throwing, where it safely can', () => {
    // A file written by a buggy build should still open. Refusing the whole show
    // because one quick change has a numeric cue would be the wrong trade.
    const parsed = parseShowFile({
      showFile: 1,
      show: { name: '  Hamlet  ', periodCount: '3', currentAct: 99 },
      players: [
        { realName: 'Ada', quickChanges: [{ outCue: 42, sortIndex: 'x' }] },
        'not a player',
        { characterName: 'Ghost' },
      ],
      micCheck: 'not an array',
    });
    expect(parsed.show.name).toBe('Hamlet');
    expect(parsed.show.periodCount).toBe(3);
    // currentAct cannot exceed the number of periods, or the mic check opens on
    // an act that does not exist.
    expect(parsed.show.currentAct).toBe(3);
    expect(parsed.players).toHaveLength(2);
    expect(parsed.players[0].quickChanges[0].outCue).toBe('');
    // A player with no name gets a placeholder rather than being dropped: an
    // empty row is fixable, a missing one is invisible.
    expect(parsed.players[1].realName).toBe('Performer 2');
    expect(parsed.micCheck).toEqual([]);
  });

  it('drops mic-check entries for acts the show no longer has', () => {
    // Otherwise they are invisible in the UI and impossible to delete.
    const parsed = parseShowFile({
      showFile: 1,
      show: { name: 'Cut down', periodCount: 1 },
      micCheck: [
        { act: 1, channelKey: 'a', checked: true },
        { act: 4, channelKey: 'b', checked: true },
      ],
    });
    expect(parsed.micCheck.map(e => e.channelKey)).toEqual(['a']);
  });

  it('collapses a duplicate (act, channel) instead of violating the unique index', () => {
    const parsed = parseShowFile({
      showFile: 1,
      show: { name: 'Dupes', periodCount: 1 },
      micCheck: [
        { act: 1, channelKey: 'a', checked: false, notes: 'first' },
        { act: 1, channelKey: 'a', checked: true, notes: 'second' },
      ],
    });
    expect(parsed.micCheck).toHaveLength(1);
    expect(parsed.micCheck[0]).toMatchObject({ checked: true, notes: 'second' });
  });

  it('clamps periodCount to what the application allows', () => {
    expect(parseShowFile({ showFile: 1, show: { name: 'x', periodCount: 500 } }).show.periodCount).toBe(12);
    expect(parseShowFile({ showFile: 1, show: { name: 'x', periodCount: 0 } }).show.periodCount).toBe(1);
  });
});

describe('showFileKey', () => {
  it('accepts a uuid', () => {
    expect(showFileKey('b0a1c2d3-0000-4000-8000-000000000001'))
      .toBe('b0a1c2d3-0000-4000-8000-000000000001');
  });

  it('refuses anything Meros would reject, here rather than in a venue', () => {
    for (const bad of ['', '-leading', 'has space', 'slash/es', 'a'.repeat(192)]) {
      expect(() => showFileKey(bad)).toThrowError(/document key/);
    }
  });
});

describe('the float tripwire', () => {
  it('contains no floating-point numbers anywhere', () => {
    // Not arbitrary fussiness. Meros hashes a canonical JSON form and RFDeck
    // reproduces it to spot a benign push conflict — but PHP and JavaScript do
    // not always render the same float identically (1.0 versus 1), so one float
    // in a show file could make the two hashes disagree for a document that is
    // in fact identical.
    //
    // Show files are strings, integers, booleans and nulls today. If a future
    // field introduces a float, this fails and sends whoever added it to
    // `contentHash` in documents.ts to decide what to do about it — which is
    // better than the hash quietly stopping working.
    const floats: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === 'number') {
        if (!Number.isInteger(value)) floats.push(`${path} = ${value}`);
      } else if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
      } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      }
    };
    walk(buildShowFile(row()), 'showFile');
    expect(floats).toEqual([]);
  });
});
