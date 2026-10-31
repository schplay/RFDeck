import crypto from 'crypto';
import { CloudRefused } from './merosClient';
import { CloudLink } from './link';

/**
 * Document sync: named, versioned JSON owned by a Meros account.
 *
 * Explicit and manual, not a background mirror. An operator moving between venues
 * wants *"get my show from last week"*, not merge semantics on a live rig — so
 * push and pull are things they ask for, and a conflict is a question they answer
 * rather than something resolved behind them.
 *
 * Versions are monotonic integers from 1. A push carries the `base_version` it was
 * edited from; if the head has moved, Meros answers **409** with the head attached
 * and changes nothing. That is the whole safety property, and it is why the local
 * version has to be remembered between pushes.
 */

export interface DocumentSummary {
  key: string;
  head_version: number;
  updated_at: string;
}

export interface DocumentListing {
  product: string;
  collection: string;
  documents: DocumentSummary[];
}

export interface DocumentVersionInfo {
  version: number;
  size_bytes?: number;
  created_at?: string;
}

export interface FetchedDocument<T = unknown> {
  key: string;
  /** The version actually returned — the head, or the one asked for. */
  version: number;
  /**
   * The current head.
   *
   * Differs from `version` when an older version was fetched deliberately, which
   * is the only way to know that what is in hand is not current.
   */
  headVersion: number;
  body: T;
  contentHash: string | null;
}

/** The document, or the version, is not in the cloud. A normal answer, not a fault. */
export class DocumentNotFound extends Error {
  constructor(readonly key: string, readonly version?: number) {
    super(version
      ? `Version ${version} of "${key}" is not in the cloud.`
      : `"${key}" has not been saved to the cloud.`);
    this.name = 'DocumentNotFound';
  }
}

/**
 * A push refused because someone saved different content first. Carries what is
 * needed to offer a choice. An identical copy is not a conflict: the helper
 * reports it as `unchanged` and nothing is written.
 */
export class DocumentConflict extends Error {
  constructor(
    readonly headVersion: number,
    readonly headContentHash: string | null,
  ) {
    super(`The cloud copy changed and is now version ${headVersion}.`);
    this.name = 'DocumentConflict';
  }
}

export const PRODUCT = 'rfdeck';

/**
 * Meros's canonical JSON form, which its `content_hash` is computed over.
 *
 * Recursively sort object keys; leave array order alone; no whitespace. Slashes
 * and non-ASCII stay unescaped, which is what `JSON.stringify` already does — so
 * the only work is the key sort.
 *
 * Sorting is what makes the hash reproducible at all. Meros originally hashed its
 * own re-encoding of whatever we sent, which meant our digest could never match
 * and every 409 looked like a real conflict; it now hashes this canonical form
 * instead, so both sides can arrive at the same answer independently.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Array order is meaningful and is left exactly as it is.
    return value.map(canonicalise);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalise((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Meros's `content_hash`, computed locally.
 *
 * The same value Meros and the meros-client helper compute, so this machine can
 * tell whether its own copy of a show still matches what it last synced
 * without asking. It never decides a conflict: that is the integer version,
 * decided by Meros.
 *
 * One known limit, deliberately left as a failing test rather than a comment
 * nobody reads: floating-point numbers. Languages do not always render the same
 * float identically (`1.0` versus `1`), so a document containing one could hash
 * differently on each side. Show files contain no floats, and
 * `showFile.test.ts` asserts that, so if a future field introduces one the test
 * fails and points here.
 */
export function contentHash(body: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

/** Meros's cap on a document body. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** The helper's answer to `cloud.docs.get`. */
interface DocAnswer {
  key: string;
  version: number;
  head_version: number;
  body: unknown;
  content_hash: string | null;
}

/**
 * The document store, through the meros-client helper (`cloud.docs.*`), acting
 * as this instance.
 */
export class Documents {
  constructor(private readonly link: CloudLink) {}

  async list(collection: string): Promise<DocumentListing> {
    const res = await this.link.run<{ docs: Array<{ key: string; head_version: number; updated: string }> }>(
      'cloud.docs.list', { product: PRODUCT, collection },
    );
    return {
      product: PRODUCT,
      collection,
      documents: (res.docs ?? []).map(d => ({ key: d.key, head_version: d.head_version, updated_at: d.updated })),
    };
  }

  /** Fetch the head, or a specific version. */
  async get<T = unknown>(collection: string, key: string, version?: number): Promise<FetchedDocument<T>> {
    let raw: DocAnswer;
    try {
      raw = await this.link.run<DocAnswer>('cloud.docs.get', {
        product: PRODUCT, collection, key, ...(version ? { version } : {}),
      });
    } catch (err) {
      // "Not in the cloud" is an ordinary answer — a show that has never been
      // pushed — and the UI needs to tell it apart from the cloud being broken.
      if (err instanceof CloudRefused && err.status === 404) throw new DocumentNotFound(key, version);
      throw err;
    }
    if (!raw.body || typeof raw.body !== 'object') {
      throw new Error(`The cloud returned no document body for "${key}".`);
    }
    return {
      key: raw.key ?? key,
      version: Number(raw.version),
      headVersion: Number(raw.head_version ?? raw.version),
      body: raw.body as T,
      contentHash: typeof raw.content_hash === 'string' ? raw.content_hash : null,
    };
  }

  async versions(collection: string, key: string): Promise<DocumentVersionInfo[]> {
    const res = await this.link.run<{ versions: Array<{ version: number; created?: string; size_bytes?: number }> }>(
      'cloud.docs.versions', { product: PRODUCT, collection, key },
    );
    return (res.versions ?? []).map(v => ({ version: v.version, created_at: v.created, size_bytes: v.size_bytes }));
  }

  /**
   * Push a new version.
   *
   * @param baseVersion The version this was edited from, or undefined for a new
   *   document. Getting this wrong in either direction is a conflict rather than
   *   an overwrite, which is the point.
   * @returns `unchanged` when the cloud already holds identical content; then
   *   nothing was written and `version` is the head's.
   * @throws DocumentConflict when someone saved different content first.
   */
  async put(
    collection: string,
    key: string,
    body: unknown,
    baseVersion?: number,
  ): Promise<{ version: number; content_hash: string | null; unchanged: boolean }> {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_DOCUMENT_BYTES) {
      // Caught here so the message can say what it is rather than relaying a 413.
      throw new Error(
        `That document is ${(Buffer.byteLength(encoded, 'utf8') / 1024 / 1024).toFixed(1)} MB, ` +
        `over the 1 MB limit for cloud documents.`,
      );
    }
    try {
      const res = await this.link.run<{ version: number; content_hash: string | null; unchanged?: boolean }>(
        'cloud.docs.put',
        { product: PRODUCT, collection, key, body, ...(baseVersion === undefined ? {} : { base_version: baseVersion }) },
      );
      return { version: Number(res.version), content_hash: res.content_hash ?? null, unchanged: res.unchanged === true };
    } catch (err) {
      if (err instanceof CloudRefused && err.code === 'version_conflict') {
        throw new DocumentConflict(err.headVersion ?? 0, err.headContentHash);
      }
      throw err;
    }
  }

  async remove(collection: string, key: string): Promise<void> {
    await this.link.run('cloud.docs.delete', { product: PRODUCT, collection, key });
  }
}
