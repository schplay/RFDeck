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
  version: number;
  body: T;
  content_hash: string | null;
  updated_at: string | null;
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
 * Meros's hash, so a local body can be compared against a head without fetching it.
 *
 * Caveat worth knowing: this assumes Meros hashes the bytes it received, and that
 * our `JSON.stringify` produced them. Against the fake cloud that holds by
 * construction; against the real one, a server that re-serialises before hashing
 * (different unicode escaping, different key order) would produce a different
 * digest for the same document.
 *
 * That degrades safely rather than dangerously. The hash is only used to spot a
 * 409 that is not really a conflict; if it never matches, every 409 is simply
 * treated as a real conflict and the operator is asked. So a mismatch costs a
 * needless question, never a lost show — but it is worth confirming against
 * staging rather than assuming.
 */
export function contentHash(body: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
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
   * The single-document response shape is the one part of the contract Meros did
   * not spell out, so this accepts either a wrapper carrying `body` or a bare
   * document, rather than assuming. Being liberal here costs nothing; guessing
   * wrong would cost a pull that silently produced an empty show.
   */
  async get<T = unknown>(collection: string, key: string, version?: number): Promise<FetchedDocument<T>> {
    const token = await this.link.token();
    const url = `${this.base(collection)}/${encodeURIComponent(key)}`
      + (version ? `?version=${version}` : '');
    const raw = await this.client.json<any>('GET', url, { token });

    const body = raw && typeof raw === 'object' && 'body' in raw ? raw.body : raw;
    if (!body || typeof body !== 'object') {
      throw new Error(`The cloud returned no usable document for "${key}".`);
    }
    return {
      key,
      version: Number(raw?.version ?? raw?.head_version ?? version ?? 0),
      body: body as T,
      content_hash: typeof raw?.content_hash === 'string' ? raw.content_hash : null,
      updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : null,
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
