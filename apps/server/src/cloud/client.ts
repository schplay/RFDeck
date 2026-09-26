import { log } from '../logger';
import { CloudConfig } from './config';
import { MerosDiscovery } from './types';

/**
 * The HTTP side of talking to Meros.
 *
 * Endpoints are discovered from the well-known document rather than hard-coded,
 * because Meros says so and because it is the only thing that makes the staging
 * and production origins interchangeable configuration.
 *
 * Unreachability is a *state*, not an exception to propagate. A rig on a show LAN
 * with no route to the internet is the normal case, so "the cloud is not
 * answering" has to be something the UI can render calmly, once, rather than an
 * error that surfaces on every poll.
 */

export class CloudOffline extends Error {
  constructor(readonly detail: string) {
    super(`Meros is unreachable: ${detail}`);
    this.name = 'CloudOffline';
  }
}

/** An answer from Meros that is not a transport failure — it said no. */
export class CloudRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly retryAfterSec: number | null = null,
    /**
     * The parsed error body, when there was one.
     *
     * Kept because some refusals are *informative* rather than merely negative:
     * a 409 from document sync carries the current head so a conflict can be
     * turned into a real choice for the operator, and discarding it would leave
     * only "conflict" to show them.
     */
    readonly body: any = null,
  ) {
    super(message);
    this.name = 'CloudRefused';
  }
}

const DISCOVERY_TTL_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export class CloudClient {
  private discovery: { at: number; doc: MerosDiscovery } | null = null;

  constructor(private readonly config: CloudConfig) {}

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * The well-known document, cached for an hour.
   *
   * Cached because every device-flow poll and every refresh would otherwise
   * fetch it, and it changes about never. Not cached across restarts: a wrong
   * cached copy would be far more confusing than one extra request at boot.
   */
  async discover(): Promise<MerosDiscovery> {
    if (this.discovery && Date.now() - this.discovery.at < DISCOVERY_TTL_MS) {
      return this.discovery.doc;
    }
    const url = `${this.config.baseUrl}/.well-known/openid-configuration`;
    const doc = await this.json<MerosDiscovery>('GET', url);
    if (!doc?.token_endpoint) {
      throw new CloudRefused(200, null, `${url} returned no token_endpoint — not an OIDC issuer?`);
    }
    this.discovery = { at: Date.now(), doc };
    return doc;
  }

  /** The device-authorization endpoint, or a clear failure saying it is absent. */
  async deviceEndpoint(): Promise<string> {
    const doc = await this.discover();
    const endpoint = doc.device_authorization_endpoint;
    if (!endpoint) {
      throw new CloudRefused(
        200, null,
        'Meros does not advertise a device_authorization_endpoint, so this instance cannot be linked',
      );
    }
    return endpoint;
  }

  async tokenEndpoint(): Promise<string> {
    return (await this.discover()).token_endpoint;
  }

  async revocationEndpoint(): Promise<string | null> {
    return (await this.discover()).revocation_endpoint ?? null;
  }

  /**
   * A JSON request, with transport failure separated from refusal.
   *
   * Anything that means "we never got an answer" becomes CloudOffline; anything
   * where Meros answered becomes CloudRefused carrying its status and error code.
   * The distinction is the whole point: one is a network to wait out, the other
   * is something an operator has to act on.
   */
  async json<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    init: { body?: unknown; form?: Record<string, string>; token?: string; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...init.headers };
    let body: string | undefined;

    if (init.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    } else if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    if (init.token) headers.Authorization = `Bearer ${init.token}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: any) {
      throw new CloudOffline(err?.cause?.code ?? err?.name ?? err?.message ?? 'unknown');
    }

    const text = await response.text().catch(() => '');
    let parsed: any = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { /* not JSON; keep the text for the message */ }
    }

    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new CloudRefused(
        response.status,
        typeof parsed?.error === 'string' ? parsed.error : null,
        parsed?.error_description ?? parsed?.message ?? parsed?.error ?? text.slice(0, 200) ??
          `HTTP ${response.status}`,
        Number.isFinite(retryAfter) ? retryAfter : null,
        parsed,
      );
    }
    return parsed as T;
  }

  /** Whether an error means "wait for the network", not "tell the operator". */
  static isOffline(err: unknown): err is CloudOffline {
    return err instanceof CloudOffline;
  }

  logOnce(what: string, err: unknown) {
    if (CloudClient.isOffline(err)) log.debug(`[Cloud] ${what}: ${(err as CloudOffline).detail}`);
    else log.warn(`[Cloud] ${what}: ${(err as Error)?.message}`);
  }
}
