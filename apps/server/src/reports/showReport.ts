import { prisma } from '../db';
import { showInclude } from '../routes/shows';

// The show report: one document over everything the server holds about a show.
//
// Built in two halves on purpose. `assembleReport` is a pure function over
// plain data, so its tabulation and both renderers are unit-testable without
// a database; `buildShowReport` does the querying and hands the result over.

export interface ReportDevice {
  name: string; manufacturer: string; model: string; ip: string;
  location: string | null; serial: string | null; firmware: string | null;
  mac: string | null; active: boolean;
}

export interface ReportCasting {
  name: string; role: string; channel: string | null; iem: string | null; notes: string;
  /** How the person is rigged — from the roster, not this show. */
  fitNotes: string;
  quickChanges: Array<{ act: number | null; outCue: string; inCue: string; notes: string }>;
}

export interface ReportCheckEntry {
  channel: string; checked: boolean;
  checkedAt: string | null; checkedBy: string | null; notes: string | null;
}

export interface ReportAct {
  act: number; entries: ReportCheckEntry[]; checked: number; total: number;
}

export interface ReportEvent {
  timestamp: string; source: string; type: string; severity: string;
  channel: string | null; device: string | null; message: string; acknowledged: boolean;
}

export interface ReportBattery {
  channel: string; percent: number | null;
  minutesRemaining: number | null; confident: boolean;
}

export interface ShowReport {
  generatedAt: string;
  /** The time span events were drawn from, and why those bounds were chosen. */
  window: { from: string; to: string; basis: string };
  show: {
    id: string; name: string; environmentMode: string;
    date: string | null; venue: string | null; notes: string | null;
    archived: boolean; currentAct: number; createdAt: string; updatedAt: string;
  };
  devices: ReportDevice[];
  roster: ReportCasting[];
  micCheck: ReportAct[];
  events: ReportEvent[];
  /** Live at the moment of generation — not history. */
  battery: ReportBattery[];
}

// ── Assembly (pure) ─────────────────────────────────────────────────────────

export interface ReportInputs {
  show: any;                      // Prisma Show with players + micCheck
  devices: any[];                 // Prisma InventoryDevice rows
  events: any[];                  // Prisma Event rows within the window
  window: { from: Date; to: Date; basis: string };
  battery: ReportBattery[];
  now?: Date;
}

export function assembleReport(input: ReportInputs): ShowReport {
  const { show, devices, events, window, battery } = input;
  const now = input.now ?? new Date();

  // Group mic-check rows by act, in act order, channels alphabetical — a
  // stage manager reads this top to bottom against a running order.
  const byAct = new Map<number, ReportCheckEntry[]>();
  for (const e of show.micCheck ?? []) {
    const list = byAct.get(e.act) ?? [];
    list.push({
      channel:   e.channelKey,
      checked:   !!e.checked,
      checkedAt: e.checkedAt ? new Date(e.checkedAt).toISOString() : null,
      checkedBy: e.checkedBy ?? null,
      notes:     e.notes ?? null,
    });
    byAct.set(e.act, list);
  }
  const micCheck: ReportAct[] = [...byAct.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([act, entries]) => {
      entries.sort((a, b) => a.channel.localeCompare(b.channel));
      return { act, entries, checked: entries.filter(e => e.checked).length, total: entries.length };
    });

  return {
    generatedAt: now.toISOString(),
    window: { from: window.from.toISOString(), to: window.to.toISOString(), basis: window.basis },
    show: {
      id: show.id, name: show.name, environmentMode: show.environmentMode,
      date: show.date ?? null, venue: show.venue ?? null, notes: show.notes ?? null,
      archived: !!show.archived, currentAct: show.currentAct,
      createdAt: new Date(show.createdAt).toISOString(),
      updatedAt: new Date(show.updatedAt).toISOString(),
    },
    devices: devices.map(d => ({
      name: d.name, manufacturer: d.manufacturer, model: d.model, ip: d.ip,
      location: d.location ?? null, serial: d.serial ?? null,
      firmware: d.firmware ?? null, mac: d.mac ?? null, active: d.active !== false,
    })),
    roster: (show.players ?? []).map((p: any) => ({
      name: p.realName, role: p.characterName ?? '',
      channel: p.assignedChannelKey ?? null,
      iem: p.iemChannelKey ?? null, notes: p.notes ?? '',
      fitNotes: p.performer?.fitNotes ?? '',
      quickChanges: (p.quickChanges ?? []).map((q: any) => ({
        act: q.act ?? null, outCue: q.outCue ?? '', inCue: q.inCue ?? '', notes: q.notes ?? '',
      })),
    })),
    micCheck,
    events: events.map(e => ({
      timestamp: new Date(e.timestamp).toISOString(),
      source: e.source, type: e.type, severity: e.severity,
      channel: e.channelName ?? e.channelKey ?? null,
      device: e.deviceId ?? null, message: e.message, acknowledged: !!e.acknowledged,
    })),
    battery,
  };
}

// ── Window ──────────────────────────────────────────────────────────────────
//
// Events are not tagged with a show, so the report bounds them in time. The
// show's own lifetime is the honest default: from when it was created until it
// was archived, or now. An operator can override either end.
export function reportWindow(
  show: { createdAt: Date; archivedAt: Date | null },
  override: { from?: string; to?: string },
  now = new Date(),
): { from: Date; to: Date; basis: string } {
  const parse = (s?: string) => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const from = parse(override.from) ?? show.createdAt;
  const to   = parse(override.to)   ?? show.archivedAt ?? now;
  const basis = override.from || override.to
    ? 'operator-specified range'
    : show.archivedAt ? 'show creation to archive' : 'show creation to now';
  return { from, to, basis };
}

// ── Querying ────────────────────────────────────────────────────────────────

export async function buildShowReport(
  showId: string,
  override: { from?: string; to?: string },
  battery: ReportBattery[],
): Promise<ShowReport | null> {
  const show = await prisma.show.findUnique({ where: { id: showId }, include: showInclude });
  if (!show) return null;

  const window = reportWindow(show, override);
  const [devices, events] = await Promise.all([
    prisma.inventoryDevice.findMany({ orderBy: { name: 'asc' } }),
    prisma.event.findMany({
      where: { timestamp: { gte: window.from, lte: window.to } },
      orderBy: { timestamp: 'asc' },
      take: 20_000,
    }),
  ]);

  return assembleReport({ show, devices, events, window, battery });
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (cells: unknown[]) => cells.map(csvCell).join(',');

// One file, several sections, each headed by a "# Section" line. Spreadsheets
// open it as-is; anything parsing it can split on the markers.
export function reportToCsv(r: ShowReport): string {
  const lines: string[] = [];
  const section = (title: string, header: string[], rows: unknown[][]) => {
    if (lines.length) lines.push('');
    lines.push(`# ${title}`);
    lines.push(row(header));
    for (const cells of rows) lines.push(row(cells));
  };

  section('Show', ['Field', 'Value'], [
    ['Name', r.show.name], ['Mode', r.show.environmentMode], ['Date', r.show.date ?? ''],
    ['Venue', r.show.venue ?? ''], ['Notes', r.show.notes ?? ''],
    ['Archived', r.show.archived ? 'yes' : 'no'], ['Generated', r.generatedAt],
    ['Events from', r.window.from], ['Events to', r.window.to], ['Window basis', r.window.basis],
  ]);

  section('Devices', ['Name', 'Manufacturer', 'Model', 'IP', 'Location', 'Serial', 'Firmware', 'MAC', 'Active'],
    r.devices.map(d => [d.name, d.manufacturer, d.model, d.ip, d.location ?? '', d.serial ?? '',
                        d.firmware ?? '', d.mac ?? '', d.active ? 'yes' : 'no']));

  section('Roster', ['Name', 'Role', 'Mic', 'IEM', 'Notes', 'Mic & pack'],
    r.roster.map(c => [c.name, c.role, c.channel ?? '', c.iem ?? '', c.notes, c.fitNotes]));

  const changes = r.roster.flatMap(c =>
    c.quickChanges.map(q => [c.name, q.act ?? '', q.outCue, q.inCue, q.notes]));
  if (changes.length > 0) {
    section('Quick changes', ['Performer', 'Act', 'Off at', 'Back at', 'Notes'], changes);
  }

  section('Mic check', ['Act', 'Channel', 'Checked', 'Checked at', 'Checked by', 'Notes'],
    r.micCheck.flatMap(a => a.entries.map(e =>
      [a.act, e.channel, e.checked ? 'yes' : 'no', e.checkedAt ?? '', e.checkedBy ?? '', e.notes ?? ''])));

  section('Events', ['Timestamp', 'Source', 'Type', 'Severity', 'Channel', 'Device', 'Message', 'Acknowledged'],
    r.events.map(e => [e.timestamp, e.source, e.type, e.severity, e.channel ?? '', e.device ?? '',
                       e.message, e.acknowledged ? 'yes' : 'no']));

  section('Battery (at generation)', ['Channel', 'Percent', 'Minutes remaining', 'Confident'],
    r.battery.map(b => [b.channel, b.percent ?? '', b.minutesRemaining ?? '', b.confident ? 'yes' : 'no']));

  return lines.join('\r\n') + '\r\n';
}

// ── HTML ────────────────────────────────────────────────────────────────────
//
// Printable as-is: the browser's print dialog (or Electron's print-to-PDF)
// turns it into the PDF, so there is no PDF dependency to carry.

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '';

function table(header: string[], rows: unknown[][], empty: string): string {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  const th = header.map(h => `<th>${escapeHtml(h)}</th>`).join('');
  const tr = rows.map(cells => `<tr>${cells.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('\n');
  return `<table><thead><tr>${th}</tr></thead><tbody>\n${tr}\n</tbody></table>`;
}

export function reportToHtml(r: ShowReport): string {
  const e = escapeHtml;
  const acts = r.micCheck.length === 0
    ? '<p class="empty">No mic-check entries recorded.</p>'
    : r.micCheck.map(a => `
      <h3>Act ${a.act} <span class="tally">${a.checked} / ${a.total} checked</span></h3>
      ${table(['Channel', 'Checked', 'At', 'By', 'Notes'],
        a.entries.map(x => [x.channel, x.checked ? '✓' : '—', fmt(x.checkedAt), x.checkedBy ?? '', x.notes ?? '']),
        'No entries for this act.')}`).join('\n');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${e(r.show.name)} — RFDeck show report</title>
<style>
  :root { color-scheme: light; }
  body { font: 13px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 32px auto; max-width: 1000px; padding: 0 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 8px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  h3 { font-size: 14px; margin: 16px 0 6px; } .tally { font-weight: normal; color: #666; margin-left: 8px; }
  .meta { color: #555; margin: 0 0 16px; } .meta span + span::before { content: " · "; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  th { background: #f4f4f4; font-weight: 600; } .empty { color: #777; font-style: italic; }
  .toolbar { position: sticky; top: 0; background: #fff; padding: 8px 0 12px; display: flex; gap: 8px; align-items: center; }
  .toolbar button { font: inherit; padding: 6px 12px; cursor: pointer; } .note { color: #666; font-size: 12px; }
  @media print { .toolbar { display: none; } body { margin: 0; max-width: none; } h2 { page-break-after: avoid; } table { page-break-inside: auto; } tr { page-break-inside: avoid; } }
</style></head><body>
<div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button><span class="note">Generated ${e(fmt(r.generatedAt))}</span></div>
<h1>${e(r.show.name)}</h1>
<p class="meta"><span>${e(r.show.environmentMode)}</span>${r.show.date ? `<span>${e(r.show.date)}</span>` : ''}${r.show.venue ? `<span>${e(r.show.venue)}</span>` : ''}${r.show.archived ? '<span>Archived</span>' : ''}</p>
${r.show.notes ? `<p>${e(r.show.notes)}</p>` : ''}

<h2>Devices</h2>
${table(['Name', 'Model', 'IP', 'Location', 'Serial', 'Firmware', 'Active'],
  r.devices.map(d => [d.name, `${d.manufacturer} ${d.model}`, d.ip, d.location ?? '', d.serial ?? '', d.firmware ?? '', d.active ? 'yes' : 'no']),
  'No devices in inventory.')}

<h2>Roster</h2>
${table(['Name', 'Role', 'Mic', 'IEM', 'Notes', 'Mic &amp; pack'],
  r.roster.map(c => [c.name, c.role, c.channel ?? '—', c.iem ?? '—', c.notes, c.fitNotes]), 'No one cast.')}

${r.roster.some(c => c.quickChanges.length > 0) ? `
<h2>Quick changes</h2>
${table(['Performer', 'Act', 'Off at', 'Back at', 'Notes'],
  r.roster.flatMap(c => c.quickChanges.map(q =>
    [c.name, q.act ?? '—', q.outCue, q.inCue, q.notes])),
  'None recorded.')}` : ''}

<h2>Mic check</h2>
${acts}

<h2>Events <span class="tally">${e(r.window.basis)}: ${e(fmt(r.window.from))} → ${e(fmt(r.window.to))}</span></h2>
${table(['Time', 'Severity', 'Type', 'Channel', 'Message', 'Ack'],
  r.events.map(x => [fmt(x.timestamp), x.severity, x.type, x.channel ?? '', x.message, x.acknowledged ? '✓' : '']),
  'No events in this window.')}

<h2>Battery <span class="tally">live at generation</span></h2>
${table(['Channel', 'Percent', 'Minutes remaining'],
  r.battery.map(b => [b.channel, b.percent ?? '—', b.confident && b.minutesRemaining !== null ? b.minutesRemaining : '—']),
  'No battery data.')}
</body></html>`;
}
