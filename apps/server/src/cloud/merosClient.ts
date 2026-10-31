import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { log } from '../logger';
import { defaultTlsDir } from '../tls';
import { CloudConfig } from './config';

/**
 * Meros Cloud, through the shared `meros-client` helper.
 *
 * Every Meros product talks to the cloud through one client, written once in
 * Rust (meros-co/meros-client). For a Node server that is its command-line
 * helper: one JSON object in on stdin, one out on stdout, and an exit code that
 * says what kind of answer it is. The helper keeps nothing in memory between
 * calls; sessions, refresh tokens, the cached entitlements answer and the event
 * outbox live in a state directory beside this install's database, sealed with
 * a key kept next to it.
 *
 * What stays RFDeck's is everything above the wire: the gate and its four flags,
 * the show-file and config-backup logic, TV-occupancy geometry, and what the UI
 * is told. See docs/cli.md in meros-client for every command used here.
 *
 * Nothing about where Meros is lives in the helper. `issuer` is passed on every
 * call from `MEROS_BASE_URL`, so an install with no cloud configured never starts
 * it at all.
 */

/** No answer from Meros: the network, not a refusal (exit 2). */
export class CloudOffline extends Error {
  constructor(readonly detail: string) {
    super(`Meros is unreachable: ${detail}`);
    this.name = 'CloudOffline';
  }
}

/** Meros said no (exit 1). `code` is Meros's own error code, unchanged. */
export class CloudRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly retryAfterSec: number | null = null,
    /** On a document `version_conflict`: the head that won. */
    readonly headVersion: number | null = null,
    readonly headContentHash: string | null = null,
  ) {
    super(message);
    this.name = 'CloudRefused';
  }
}

/**
 * The helper's local state is missing or does not verify (exit 4): no session,
 * a sealed file that will not open, a login request not begun here.
 */
export class CloudLocalState extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CloudLocalState';
  }
}

/** The call was stopped on purpose, by its `signal`. */
export class SignInCanceled extends Error {
  constructor() {
    super('The sign-in was canceled.');
    this.name = 'SignInCanceled';
  }
}

/** Which identity a call acts as, and the OAuth client it belongs to. */
export interface MerosSession {
  /**
   * The handle in the helper's state directory. Null lets the helper pick: for
   * a person's sign-in, one session per person.
   */
  name: string | null;
  clientId: string;
  scopes: readonly string[];
}

/** A call that takes longer than this is a wedged helper, not a slow network. */
const CALL_TIMEOUT_MS = 90_000;

/** For the one call that waits on a person rather than the network. */
export interface RunOptions {
  timeoutMs?: number;
  /** Stops the helper, as when the operator cancels a sign-in. */
  signal?: AbortSignal;
  /** Each line the helper writes to stderr, as it writes it. */
  onStderrLine?: (line: string) => void;
}

/**
 * Where the helper binary is.
 *
 * `MEROS_CLIENT_BIN` wins. Otherwise beside the server build (`apps/server/bin`,
 * where the build puts it and the packaged apps carry it).
 */
export function resolveMerosClientBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MEROS_CLIENT_BIN?.trim()) return env.MEROS_CLIENT_BIN.trim();
  const exe = process.platform === 'win32' ? 'meros-client.exe' : 'meros-client';
  return path.resolve(__dirname, '..', '..', 'bin', exe);
}

/** The helper's state directory and key file, beside the database. */
export function merosStatePaths(dataDir: string = defaultTlsDir()): { stateDir: string; keyFile: string } {
  // The key file must be outside the state directory: the helper refuses one
  // inside it, so that copying the directory alone carries no secret.
  return { stateDir: path.join(dataDir, 'meros'), keyFile: path.join(dataDir, 'meros-client.key') };
}

export class MerosClient {
  private readonly common: Record<string, unknown>;
  private warnedMissing = false;

  constructor(
    config: CloudConfig,
    private readonly bin: string = resolveMerosClientBinary(),
    paths: { stateDir: string; keyFile: string } = merosStatePaths(),
  ) {
    const keys: Record<string, string> = {};
    for (const [kid, key] of config.packKeys) keys[kid] = key.toString('base64url');
    this.common = {
      state_dir: paths.stateDir,
      key_file: paths.keyFile,
      issuer: config.baseUrl,
      product: 'rfdeck',
      app_name: 'RFDeck',
      app_version: process.env.RFDECK_VERSION ?? '0.0.0',
      keys,
    };
  }

  get stateDir(): string {
    return this.common.state_dir as string;
  }

  /**
   * Run one command and return its answer.
   *
   * @throws CloudOffline, CloudRefused or CloudLocalState, by exit code.
   */
  async run<T = any>(
    command: string,
    input: Record<string, unknown> = {},
    session?: MerosSession,
    options: RunOptions = {},
  ): Promise<T> {
    const request: Record<string, unknown> = { ...this.common, ...input };
    if (session) {
      if (session.name) request.session = session.name;
      request.client_id = session.clientId;
      request.scopes = [...session.scopes];
    }

    if (!fs.existsSync(this.bin)) {
      if (!this.warnedMissing) {
        this.warnedMissing = true;
        log.error(`[Cloud] The meros-client helper is not at ${this.bin}; cloud features cannot work`);
      }
      throw new CloudLocalState('helper_missing', `The meros-client helper is not installed at ${this.bin}.`);
    }

    const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      const child = execFile(
        this.bin, [command],
        {
          timeout: options.timeoutMs ?? CALL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
          signal: options.signal,
        },
        (err, out, errOut) => {
          const exit = err ? (typeof (err as any).code === 'number' ? (err as any).code : -1) : 0;
          resolve({ code: exit, stdout: out ?? '', stderr: errOut ?? '' });
        },
      );
      if (options.onStderrLine) {
        let partial = '';
        child.stderr?.on('data', (chunk: Buffer | string) => {
          const lines = (partial + chunk.toString()).split(/\r?\n/);
          partial = lines.pop() ?? '';
          for (const line of lines) if (line.trim()) options.onStderrLine!(line);
        });
      }
      child.stdin?.end(JSON.stringify(request));
    });

    if (options.signal?.aborted) throw new SignInCanceled();

    let answer: any = null;
    try { answer = JSON.parse(stdout); } catch { /* reported below */ }

    if (code === 0 && answer?.ok === true) return answer as T;

    const error = answer?.error ?? {};
    const message = typeof error.message === 'string' ? error.message
      : (stderr.trim() || `meros-client ${command} exited with ${code}`);
    const errorCode = typeof error.code === 'string' ? error.code : null;
    switch (code) {
      case 1:
        throw new CloudRefused(
          Number(error.status ?? 0), errorCode, message,
          Number.isFinite(Number(error.retry_after)) ? Number(error.retry_after) : null,
          Number.isFinite(Number(error.head_version)) ? Number(error.head_version) : null,
          typeof error.head_content_hash === 'string' ? error.head_content_hash : null,
        );
      case 2:
        throw new CloudOffline(message);
      case 4:
        throw new CloudLocalState(errorCode ?? 'state_error', message);
      default:
        // Exit 3 is a bad call from this side, and anything else is the helper
        // failing outright. Neither is something an operator can act on.
        throw new Error(`meros-client ${command} failed (${errorCode ?? `exit ${code}`}): ${message}`);
    }
  }
}
