import { describe, it, expect } from 'vitest';
import {
  assembleReport, reportWindow, reportToCsv, reportToHtml, csvCell, escapeHtml,
} from './showReport';

// The report is the document a stage manager files after a run. The parts
// worth pinning are the ones that would silently produce a wrong document:
// CSV cells that break a spreadsheet, HTML that lets a channel name inject
// markup, acts out of order, and an event window that quietly excludes the
// show.

const T0 = new Date('2026-08-20T18:00:00Z');
const T1 = new Date('2026-08-20T22:30:00Z');

const show = {
  id: 's1', name: 'Our Town', environmentMode: 'THEATER',
  date: '2026-08-20', venue: 'Main Stage', notes: null,
  archived: false, archivedAt: null, currentAct: 2,
  createdAt: T0, updatedAt: T1,
  players: [
    { realName: 'Dana', characterName: 'Emily', notes: '', assignedChannelKey: 'HH 3', iemChannelKey: 'IEM 1' },
    { realName: 'Lee',  characterName: 'George', notes: 'quick change act 2', assignedChannelKey: null, iemChannelKey: null },
  ],
  micCheck: [
    { act: 2, channelKey: 'HH 3', checked: true,  checkedAt: T1, checkedBy: null, notes: null },
    { act: 1, channelKey: 'HH 3', checked: true,  checkedAt: T0, checkedBy: 'FOH', notes: 'crackle fixed' },
    { act: 1, channelKey: 'HH 1', checked: false, checkedAt: null, checkedBy: null, notes: null },
  ],
};

const devices = [
  { name: 'EM 2 Rack A', manufacturer: 'Sennheiser', model: 'EW-DX EM 2', ip: '10.0.0.5',
    location: 'SL rack', serial: 'ABC', firmware: '4.1', mac: null, active: true },
];

const events = [
  { timestamp: new Date('2026-08-20T19:05:00Z'), source: 'RF', type: 'DROPOUT', severity: 'WARNING',
    channelName: 'HH 3', channelKey: 'HH 3', deviceId: '10.0.0.5:443', message: 'RF dropout', acknowledged: false },
];

const inputs = () => ({
  show, devices, events,
  window: { from: T0, to: T1, basis: 'show creation to now' },
  battery: [{ channel: 'HH 3', percent: 62, minutesRemaining: 140, confident: true }],
  now: T1,
});

describe('assembleReport', () => {
  it('orders acts numerically and channels alphabetically within an act', () => {
    const r = assembleReport(inputs());
    expect(r.micCheck.map(a => a.act)).toEqual([1, 2]);
    expect(r.micCheck[0].entries.map(e => e.channel)).toEqual(['HH 1', 'HH 3']);
  });

  it('tallies checked against total per act', () => {
    const r = assembleReport(inputs());
    expect(r.micCheck[0]).toMatchObject({ checked: 1, total: 2 });
    expect(r.micCheck[1]).toMatchObject({ checked: 1, total: 1 });
  });

  it('carries a performer\'s mic and IEM separately', () => {
    const r = assembleReport(inputs());
    expect(r.roster[0]).toMatchObject({ name: 'Dana', channel: 'HH 3', iem: 'IEM 1' });
    // Someone with neither must read as unassigned, not as an empty string
    // that could be mistaken for a channel named "".
    expect(r.roster[1]).toMatchObject({ name: 'Lee', channel: null, iem: null });
  });

  it('shows both assignments in the CSV and the printable page', () => {
    const r = assembleReport(inputs());
    const csv = reportToCsv(r);
    expect(csv).toContain('Name,Role,Mic,IEM,Notes');
    expect(csv).toContain('Dana,Emily,HH 3,IEM 1');
    expect(reportToHtml(r)).toContain('IEM 1');
  });

  it('carries who checked and when, as ISO strings', () => {
    const r = assembleReport(inputs());
    const hh3 = r.micCheck[0].entries.find(e => e.channel === 'HH 3')!;
    expect(hh3.checkedBy).toBe('FOH');
    expect(hh3.checkedAt).toBe(T0.toISOString());
  });

  it('prefers the event channel name and falls back to the key', () => {
    const r = assembleReport({ ...inputs(), events: [
      { ...events[0], channelName: null },
    ] });
    expect(r.events[0].channel).toBe('HH 3');
  });
});

describe('reportWindow', () => {
  it('spans creation to now for a live show', () => {
    const w = reportWindow({ createdAt: T0, archivedAt: null }, {}, T1);
    expect(w).toEqual({ from: T0, to: T1, basis: 'show creation to now' });
  });

  it('ends at the archive time for an archived show', () => {
    const w = reportWindow({ createdAt: T0, archivedAt: T1 }, {}, new Date('2026-09-01T00:00:00Z'));
    expect(w.to).toEqual(T1);
    expect(w.basis).toBe('show creation to archive');
  });

  it('lets the operator override either bound', () => {
    const w = reportWindow({ createdAt: T0, archivedAt: null }, { from: '2026-08-20T20:00:00Z' }, T1);
    expect(w.from.toISOString()).toBe('2026-08-20T20:00:00.000Z');
    expect(w.to).toEqual(T1);
    expect(w.basis).toBe('operator-specified range');
  });

  it('ignores an unparseable override rather than producing an invalid date', () => {
    const w = reportWindow({ createdAt: T0, archivedAt: null }, { from: 'yesterday-ish' }, T1);
    expect(w.from).toEqual(T0);
  });
});

describe('csv', () => {
  it('quotes cells containing commas, quotes, or newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
  });

  it('emits every section with a marker line', () => {
    const csv = reportToCsv(assembleReport(inputs()));
    for (const s of ['# Show', '# Devices', '# Roster', '# Mic check', '# Events', '# Battery']) {
      expect(csv).toContain(s);
    }
  });

  it('keeps a note with a comma inside one cell', () => {
    const csv = reportToCsv(assembleReport({ ...inputs(), show: {
      ...show, players: [{ realName: 'Lee', characterName: 'George', notes: 'wig, then hat', assignedChannelKey: null }],
    } }));
    expect(csv).toContain('"wig, then hat"');
  });
});

describe('html', () => {
  it('escapes markup in operator-entered text', () => {
    expect(escapeHtml('<b>x</b> & "y"')).toBe('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;');
  });

  it('does not let a channel name inject markup into the document', () => {
    const hostile = { ...show, micCheck: [
      { act: 1, channelKey: '<img src=x onerror=alert(1)>', checked: true, checkedAt: T0, checkedBy: null, notes: null },
    ] };
    const html = reportToHtml(assembleReport({ ...inputs(), show: hostile }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('includes the show name, each act, and the event window basis', () => {
    const html = reportToHtml(assembleReport(inputs()));
    expect(html).toContain('Our Town');
    expect(html).toContain('Act 1');
    expect(html).toContain('Act 2');
    expect(html).toContain('show creation to now');
  });

  it('shows a dash rather than a number for an unconfident battery estimate', () => {
    const html = reportToHtml(assembleReport({ ...inputs(), battery: [
      { channel: 'HH 1', percent: 80, minutesRemaining: 300, confident: false },
    ] }));
    expect(html).not.toContain('>300<');
  });
});
