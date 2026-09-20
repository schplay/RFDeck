import { log } from '../../logger';

/**
 * Addresses discovery must never contact.
 *
 * Finding receivers means touching addresses that turn out not to be
 * receivers: a TCP connect to every host on the subnet, then two HTTPS GETs
 * to each one that answers on 443, then a TLS handshake to read its
 * certificate. RFDeck is careful about what it *claims* — a host is only
 * offered when something positively identifies it as Sennheiser — but that
 * care is about the result, not the traffic. A venue network has cameras,
 * NAS boxes, hypervisors and door controllers on it, and repeatedly
 * presenting unauthenticated requests to somebody else's appliance is not
 * RFDeck's business, whatever it concludes afterwards.
 *
 * So an operator can name what to leave alone, and it is left alone at the
 * socket, before any connection is made — not filtered out of the results
 * after the fact.
 *
 * Accepts single addresses ("10.0.1.5"), CIDR ranges ("10.0.1.0/24") and
 * inclusive dashed ranges ("10.0.1.20-10.0.1.40"), separated by commas,
 * whitespace or newlines. Anything unparseable is reported and skipped
 * rather than silently widening or narrowing the list.
 */

export interface IgnoreRule {
  /** As the operator wrote it, for logs and for the settings round-trip. */
  readonly text: string;
  readonly first: number;
  readonly last: number;
}

function toInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const b = Number(p);
    if (b > 255) return null;
    n = (n * 256) + b;
  }
  return n;
}

export function parseIgnoreList(spec: string | null | undefined): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of (spec ?? '').split(/[,\s]+/)) {
    const text = raw.trim();
    if (!text) continue;

    const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(text);
    if (cidr) {
      const base = toInt(cidr[1]);
      const bits = Number(cidr[2]);
      if (base === null || bits > 32) { log.warn(`[Discovery] Ignoring unparseable exclusion "${text}"`); continue; }
      // A /0 would silently switch discovery off entirely, which is not
      // something to arrive at by typing a subnet slightly wrong.
      if (bits === 0) { log.warn(`[Discovery] Exclusion "${text}" would cover every address — skipped`); continue; }
      const size = 2 ** (32 - bits);
      const first = Math.floor(base / size) * size;
      rules.push({ text, first, last: first + size - 1 });
      continue;
    }

    const range = /^(\d+\.\d+\.\d+\.\d+)\s*-\s*(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (range) {
      const a = toInt(range[1]);
      const b = toInt(range[2]);
      if (a === null || b === null) { log.warn(`[Discovery] Ignoring unparseable exclusion "${text}"`); continue; }
      rules.push({ text, first: Math.min(a, b), last: Math.max(a, b) });
      continue;
    }

    const one = toInt(text);
    if (one === null) { log.warn(`[Discovery] Ignoring unparseable exclusion "${text}"`); continue; }
    rules.push({ text, first: one, last: one });
  }
  return rules;
}

export function isIgnored(ip: string, rules: IgnoreRule[]): boolean {
  if (rules.length === 0) return false;
  const n = toInt(ip);
  if (n === null) return false;
  return rules.some(r => n >= r.first && n <= r.last);
}
