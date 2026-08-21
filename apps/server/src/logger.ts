// Leveled logging.
//
// RFDeck runs as a long-lived service. Under systemd everything on stdout goes
// to the journal, so unconditional per-device chatter — a line every few seconds
// per receiver, times up to 128 channels — fills the journal and buries the
// events that matter.
//
// Hardware diagnostics are therefore `debug` and off by default. Set
// LOG_LEVEL=debug when troubleshooting a device that will not connect.
//
//   error  something failed and needs attention
//   warn   degraded but running
//   info   lifecycle: startup, shutdown, device connected or lost
//   debug  per-device protocol detail
//
// Default is `info`, or `warn` when NODE_ENV=production.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function resolveLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase().trim();
  if (raw && raw in ORDER) return raw as LogLevel;
  return process.env.NODE_ENV === 'production' ? 'warn' : 'info';
}

const active = resolveLevel();
const threshold = ORDER[active];

// systemd prefixes journal lines with a timestamp already, so adding our own
// only doubles it up. Include one when running in a bare terminal.
const underSystemd = !!process.env.JOURNAL_STREAM || !!process.env.INVOCATION_ID;

function emit(level: LogLevel, args: unknown[]): void {
  if (ORDER[level] > threshold) return;
  const prefix = underSystemd
    ? `[${level}]`
    : `${new Date().toISOString()} [${level}]`;
  // error and warn to stderr so journald classifies them correctly.
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(prefix, ...args);
}

export const log = {
  error: (...args: unknown[]) => emit('error', args),
  warn:  (...args: unknown[]) => emit('warn',  args),
  info:  (...args: unknown[]) => emit('info',  args),
  debug: (...args: unknown[]) => emit('debug', args),
  level: active,
  /** True when debug output is on — guard expensive message building with this. */
  get isDebug() { return threshold >= ORDER.debug; },
};
