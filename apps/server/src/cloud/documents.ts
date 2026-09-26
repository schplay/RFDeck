import crypto from 'crypto';
import { CloudClient, CloudRefused } from './client';
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
  account_id: string;
  product: string;
  collection: string;
  documents: DocumentSummary[];
}

export interface DocumentVersionInfo {
  version: number;
  content_hash?: string;
  size_bytes?: number;
  author_user_id?: string | null;
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
  createdAt: string | null;
  sizeBytes: number | null;
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

/** A push refused because the head moved. Carries what is needed to offer a choice. */
export class DocumentConflict extends Error {
  constructor(
    readonly headVersion: number,
    readonly headUpdatedAt: string | null,
    readonly headContentHash: string | null,
    /** True when the head's body is byte-identical to what we tried to push. */
    readonly sameContent: boolean,
  ) {
    super(
      sameContent
        ? 'The cloud already has this exact version.'
        : `The cloud copy changed${headUpdatedAt ? ` at ${headUpdatedAt}` : ''} and is now version ${headVersion}.`,
    );
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
 * Used for exactly one thing: telling a **benign** conflict from a real one. When
 * the head's hash equals ours, two machines are holding an identical document and
 * there is nothing for an operator to arbitrate.
 *
 * It is deliberately *not* how a conflict is detected. That is the integer
 * version, decided by Meros — a 409 means the head advanced past our
 * `base_version`, full stop. A version comparison cannot false-positive; a hash
 * computed from our own serialisation could, which is why it only ever downgrades
 * a prompt and never suppresses a conflict.
 *
 * One known limit, deliberately left as a failing test rather than a comment
 * nobody reads: floating-point numbers. PHP and JavaScript do not always render
 * the same float identically (`1.0` versus `1`), so a document containing one
 * could hash differently on each side. Show files contain no floats, and
 * `showFile.test.ts` asserts that, so if a future field introduces one the test
 * fails and points here.
 */
export function contentHash(body: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

/** Meros's cap on a document body. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

export class Documents {
  constructor(
    private readonly client: CloudClient,
    private readonly link: CloudLink,
  ) {}

  private base(collection: string): string {
    return `${this.client.baseUrl}/v1/docs/${PRODUCT}/${encodeURIComponent(collection)}`;
  }

  async list(collection: string): Promise<DocumentListing> {
    const token = await this.link.token();
    return this.client.json<DocumentListing>('GET', this.base(collection), { token });
  }

  /**
   * Fetch the head, or a specific version.
   *
   * The response is a stable envelope — `{ key, version, head_version,
   * content_hash, size_bytes, created_at, body }` — so the document is read from
   * `body` and the siblings are Meros's metadata about it.
   *
   * Deliberately keyed off the envelope rather than sniffed for. An earlier
   * version of this accepted either a wrapper or a bare document, because the
   * shape had not been specified; Meros has since guaranteed the envelope and
   * pointed out that sniffing for our own top-level keys would be the wrong test
   * anyway. It would be: a document that legitimately contained a `body` key
   * would be misread, and the check would pass for years before meeting one.
   */
  async get<T = unknown>(collection: string, key: string, version?: number): Promise<FetchedDocument<T>> {
    const token = await this.link.token();
    const url = `${this.base(collection)}/${encodeURIComponent(key)}`
      + (version ? `?version=${version}` : '');

    let raw: any;
    try {
      raw = await this.client.json<any>('GET', url, { token });
    } catch (err) {
      // "Not in the cloud" is an ordinary answer — a show that has never been
      // pushed — and the UI needs to tell it apart from the cloud being broken.
      if (err instanceof CloudRefused && err.status === 404) {
        throw new DocumentNotFound(key, version);
      }
      throw err;
    }

    if (!raw || typeof raw !== 'object' || !raw.body || typeof raw.body !== 'object') {
      throw new Error(`The cloud returned no document body for "${key}".`);
    }
    const returned = Number(raw.version ?? version ?? 0);
    return {
      key: typeof raw.key === 'string' ? raw.key : key,
      version: returned,
      headVersion: Number(raw.head_version ?? returned),
      body: raw.body as T,
      contentHash: typeof raw.content_hash === 'string' ? raw.content_hash : null,
      createdAt: typeof raw.created_at === 'string' ? raw.created_at : null,
      sizeBytes: Number.isFinite(Number(raw.size_bytes)) ? Number(raw.size_bytes) : null,
    };
  }

  async versions(collection: string, key: string): Promise<DocumentVersionInfo[]> {
    const token = await this.link.token();
    const raw = await this.client.json<any>(
      'GET', `${this.base(collection)}/${encodeURIComponent(key)}/versions`, { token },
    );
    const list = Array.isArray(raw) ? raw : raw?.versions;
    return Array.isArray(list) ? list : [];
  }

  /**
   * Push a new version.
   *
   * @param baseVersion The version this was edited from, or 0/undefined for a new
   *   document. Getting this wrong in either direction is a 409 rather than an
   *   overwrite, which is the point.
   * @throws DocumentConflict when the head has moved.
   */
  async put(
    collection: string,
    key: string,
    body: unknown,
    baseVersion?: number,
  ): Promise<{ version: number; content_hash: string | null }> {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_DOCUMENT_BYTES) {
      // Caught here so the message can say what it is rather than relaying a 413.
      throw new Error(
        `That document is ${(Buffer.byteLength(encoded, 'utf8') / 1024 / 1024).toFixed(1)} MB, ` +
        `over the 1 MB limit for cloud documents.`,
      );
    }

    const token = await this.link.token();
    try {
      // 201, and the same envelope as a GET minus `body`.
      const raw = await this.client.json<any>(
        'PUT', `${this.base(collection)}/${encodeURIComponent(key)}`,
        { token, body: baseVersion === undefined ? { body } : { body, base_version: baseVersion } },
      );
      return {
        version: Number(raw?.version ?? raw?.head_version ?? 0),
        content_hash: typeof raw?.content_hash === 'string' ? raw.content_hash : null,
      };
    } catch (err) {
      if (err instanceof CloudRefused && err.status === 409) {
        // The 409 carries the head, which is what turns "conflict" into a choice.
        const head = err.body?.head ?? {};
        const headHash = typeof head.content_hash === 'string' ? head.content_hash : null;
        // If the head's body is byte-identical to ours there is nothing to
        // resolve — two machines pushed the same show. Asking an operator to
        // arbitrate a non-conflict is how they learn to click through dialogs.
        const sameContent = !!headHash && headHash === contentHash(body);
        throw new DocumentConflict(
          Number(head.version ?? 0),
          typeof head.updated_at === 'string' ? head.updated_at : null,
          headHash,
          sameContent,
        );
      }
      throw err;
    }
  }

  async remove(collection: string, key: string): Promise<void> {
    const token = await this.link.token();
    await this.client.json('DELETE', `${this.base(collection)}/${encodeURIComponent(key)}`, { token });
  }
}
