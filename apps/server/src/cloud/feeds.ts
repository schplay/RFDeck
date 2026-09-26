import fs from 'fs';
import path from 'path';
import { log } from '../logger';
import { CloudClient, CloudRefused, CloudOffline } from './client';
import { CloudLink } from './link';
import { CloudConfig } from './config';
import { verifySignedPack, PackVerifyError, PackHeader } from './packSignature';

/**
 * Signed data packs: Meros publishes, RFDeck verifies and caches.
 *
 * One primitive behind several features — regional TV occupancy, device-profile
 * updates — because each is the same thing: a signed, versioned file that a
 * product fetches while online, trusts offline, and re-polls cheaply.
 *
 * Two properties this is built around, both of which come from the venue rather
 * than from the protocol:
 *
 *   1. **The cache is authoritative when there is no network.** A pack fetched
 *      last week is what a rig in a flight case has, and it must work. Nothing
 *      here treats "cannot reach Meros" as a failure to report.
 *   2. **Nothing unverified is ever cached or returned.** A pack is verified
 *      before it is written, so a cached file is by construction one that passed —
 *      which means a later offline read does not have to re-establish trust, and
 *      a tampered cache file cannot become data by being on disk.
 */

export interface CachedPack<T = unknown> {
  pack: string;
  header: PackHeader;
  payload: T;
  /** When this copy was fetched. */
  fetchedAt: string;
  /** From disk rather than the network on this call. */
  fromCache: boolean;
}

interface CacheFile {
  etag: string | null;
  fetchedAt: string;
  /** The verified envelope, kept whole so it can be re-verified on read. */
  response: unknown;
}

export class Feeds {
  private readonly dir: string;

  constructor(
    private readonly config: CloudConfig,
    private readonly client: CloudClient,
    private readonly link: CloudLink,
    dir?: string,
  ) {
    this.dir = dir ?? Feeds.resolveCacheDir();
  }

  /**
   * Beside the database, like clips and images — so a pack travels with the data
   * it describes and lands on whatever volume the operator pointed the install at.
   */
  static resolveCacheDir(): string {
    const url = process.env.DATABASE_URL ?? '';
    const match = url.match(/^file:(.+)$/);
    if (match) {
      const dbPath = path.resolve(process.cwd(), match[1]);
      return path.join(path.dirname(dbPath), 'packs');
    }
    return path.resolve(__dirname, '../../prisma/packs');
  }

  get directory(): string {
    return this.dir;
  }

  /**
   * Refuse a pack name that could become a path.
   *
   * Names come from us and from an index Meros signed, but they still end up in a
   * filesystem path, so anything that could climb out of the cache directory is
   * refused rather than sanitised into something surprising.
   *
   * Called at the top of every public method rather than only inside `file()`.
   * It lived there first, and `readCache` swallows exceptions by design — so the
   * check was quietly discarded and a bad name fell through to a network request
   * instead of being refused. A guard inside a function whose caller ignores
   * errors is not a guard.
   */
  private assertPackName(pack: string): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pack) || pack.includes('..')) {
      throw new Error(`"${pack}" is not a usable pack name`);
    }
  }

  private file(pack: string): string {
    this.assertPackName(pack);
    return path.join(this.dir, `${pack}.json`);
  }

  private readCache(pack: string): CacheFile | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(pack), 'utf8')) as CacheFile;
    } catch {
      return null;
    }
  }

  private writeCache(pack: string, entry: CacheFile) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file(pack), JSON.stringify(entry), 'utf8');
    } catch (err: any) {
      // A pack that cannot be cached still works for this session. Losing the
      // cache costs a re-fetch, not a feature.
      log.warn(`[Cloud] Could not cache pack "${pack}": ${err?.message}`);
    }
  }

  /**
   * Fetch a pack, or return the cached copy.
   *
   * Conditional on the stored `ETag`, so a weekly poll for something that has not
   * changed is one cheap request. A 304, an unreachable cloud and a refusal all
   * fall back to the cache; only a *verification* failure is fatal, and then only
   * for the new copy — a cached pack that previously verified is still good.
   */
  async fetch<T = unknown>(pack: string, options: { force?: boolean } = {}): Promise<CachedPack<T>> {
    this.assertPackName(pack);
    const cached = this.readCache(pack);
    const url = `${this.client.baseUrl}/v1/feeds/rfdeck/${encodeURIComponent(pack)}`;

    let token: string | undefined;
    try {
      token = await this.link.token();
    } catch {
      // Entitled packs need the link; public ones do not. Rather than deciding
      // which this is, try without a token and let Meros answer.
      token = undefined;
    }

    try {
      const headers: Record<string, string> = {};
      if (cached?.etag && !options.force) headers['If-None-Match'] = cached.etag;

      const response = await this.client.jsonWithHeaders<any>('GET', url, { token, headers });

      if (response.status === 304) {
        if (cached) return this.fromCache<T>(pack, cached);
        // 304 with nothing cached should not happen; re-ask without the header
        // rather than returning nothing.
        return this.fetch<T>(pack, { force: true });
      }

      const verified = verifySignedPack<T>(response.body, this.config.packKeys);
      // Written only after it verifies, so the cache cannot hold anything untrusted.
      this.writeCache(pack, {
        etag: response.headers.etag ?? null,
        fetchedAt: new Date().toISOString(),
        response: response.body,
      });
      log.debug(`[Cloud] Pack "${pack}" version ${verified.header.version} verified and cached`);
      return {
        pack, header: verified.header, payload: verified.payload,
        fetchedAt: new Date().toISOString(), fromCache: false,
      };
    } catch (err) {
      if (err instanceof PackVerifyError) {
        // Never silently fall back for this one. A pack that does not verify is
        // either tampered with or signed by a key this build does not have, and
        // both are worth saying out loud.
        log.error(`[Cloud] Pack "${pack}" failed verification: ${err.message}`);
        throw err;
      }
      if (cached && (err instanceof CloudOffline || err instanceof CloudRefused)) {
        log.debug(`[Cloud] Using the cached copy of "${pack}": ${(err as Error).message}`);
        return this.fromCache<T>(pack, cached);
      }
      throw err;
    }
  }

  /**
   * The cached copy, re-verified on the way out.
   *
   * Re-verifying costs a signature check and buys the guarantee that a file
   * edited on disk cannot become data. The cache is a file on a venue machine,
   * and "it was verified when we wrote it" is not the same as "it is verified now".
   */
  private fromCache<T>(pack: string, entry: CacheFile): CachedPack<T> {
    const verified = verifySignedPack<T>(entry.response as any, this.config.packKeys);
    return {
      pack, header: verified.header, payload: verified.payload,
      fetchedAt: entry.fetchedAt, fromCache: true,
    };
  }

  /** The cached copy alone, without touching the network. For a show, offline. */
  cachedOnly<T = unknown>(pack: string): CachedPack<T> | null {
    this.assertPackName(pack);
    const cached = this.readCache(pack);
    if (!cached) return null;
    try {
      return this.fromCache<T>(pack, cached);
    } catch (err) {
      log.warn(`[Cloud] Cached pack "${pack}" no longer verifies: ${(err as Error).message}`);
      return null;
    }
  }

  /** Forget a cached pack. */
  forget(pack: string) {
    this.assertPackName(pack);
    try { fs.unlinkSync(this.file(pack)); } catch { /* already gone */ }
  }
}
