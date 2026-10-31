import crypto from 'crypto';
import { prisma } from '../db';
import { log } from '../logger';
import { CloudConfig, PERSON_SCOPES } from './config';
import { CloudLocalState, CloudRefused, MerosClient, MerosSession } from './merosClient';

/**
 * People signed in to Meros in a browser, so their preferences follow them.
 *
 * Signing in here does not affect the rig: it carries a person's layout, meter
 * settings and UI state between machines and venues. The person's Meros
 * session is the meros-client helper's, one per person, under the RFDeck
 * Browser client, so it can never revoke the instance link's tokens or be
 * revoked by them. A browser holds only a token that says which person it is
 * (`x-rfdeck-person`); the Meros tokens never leave the server.
 *
 * The browser keeps that token for the tab by default, or on the machine when
 * the person says so, because a venue PC is shared and RFDeck can't tell which
 * kind of machine it is on.
 */

export interface Person {
  sub: string;
  /** The helper's session for this person. */
  session: string;
  name: string | null;
  email: string | null;
  persistent: boolean;
}

/** The person this browser is, and the token that says so. */
export interface PersonSignIn {
  token: string;
  person: Person;
}

/** The person's Meros session has ended: only signing in again helps. */
export class PersonSignedOut extends Error {
  constructor(message = 'Your Meros session ended. Sign in again to sync preferences.') {
    super(message);
    this.name = 'PersonSignedOut';
  }
}

/** What the helper answers a finished sign-in with. */
export interface SignedIn {
  status: 'signed_in';
  session: string;
  user: { id: string; name?: string | null; email?: string | null };
  replaced_previous?: boolean;
}

/** How long an unused token lasts: a sitting for the tab, a season for the machine. */
const IDLE_MS = { tab: 12 * 3600_000, machine: 90 * 86400_000 };
/** How long the code handed back through the redirect can be claimed. */
const CLAIM_MS = 120_000;
/**
 * The namespace preferences live under.
 *
 * Meros also offers a shared `meros` namespace for preferences that should
 * follow a person across the whole portfolio. Nothing RFDeck syncs today
 * qualifies (layout, meter settings and UI state are all about this app's
 * screens), so everything goes in `rfdeck`.
 */
export const PROFILE_NAMESPACE = 'rfdeck';
/** Codes that mean the person's session is gone at Meros or in the helper. */
const ENDED = new Set(['invalid_grant', 'token_rejected', 'no_sign_in']);

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export class People {
  /** Sign-ins finished through a redirect, waiting for their browser to claim them. */
  private claims = new Map<string, { result: SignedIn; persistent: boolean; expiresAt: number }>();

  constructor(
    private readonly config: CloudConfig,
    private readonly meros: MerosClient,
  ) {}

  /** Whether people can sign in here: the RFDeck Browser client is configured. */
  get configured(): boolean {
    return !!this.config.browserClientId;
  }

  /** A person's helper session. */
  session(handle: string): MerosSession {
    if (!this.config.browserClientId) throw new Error('The RFDeck Browser client is not configured.');
    return { name: handle, clientId: this.config.browserClientId, scopes: PERSON_SCOPES };
  }

  /**
   * The session a new sign-in goes into.
   *
   * Always a new handle, never the helper's one-session-per-person default:
   * that default picks any session already signed in as the same person, and
   * the person who links a rig is usually the person who signs in to it, so it
   * would put their browser sign-in into the instance link's session. One
   * session per person is kept in `issue` instead.
   */
  newSession(): MerosSession {
    return this.session(`person-${crypto.randomBytes(6).toString('hex')}`);
  }

  /** Issue the token a browser keeps for a person who has just signed in. */
  async issue(result: SignedIn, persistent: boolean): Promise<PersonSignIn> {
    // The person's earlier session here, if any, gives way to this one, and the
    // browsers signed in with it move across.
    const earlier = await prisma.personToken.findMany({
      where: { sub: result.user.id, NOT: { session: result.session } },
      distinct: ['session'],
      select: { session: true },
    });
    if (earlier.length > 0) {
      await prisma.personToken.updateMany({ where: { sub: result.user.id }, data: { session: result.session } });
      for (const { session } of earlier) {
        await this.meros.run('signin.signout', {}, this.session(session)).catch(() => {});
      }
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const person: Person = {
      sub: result.user.id,
      session: result.session,
      name: result.user.name ?? null,
      email: result.user.email ?? null,
      persistent,
    };
    await prisma.personToken.create({ data: { tokenHash: hash(token), ...person } });
    log.info(`[Cloud] ${person.email ?? person.sub} signed in to sync preferences`);
    return { token, person };
  }

  /**
   * Hold a redirect sign-in for its browser to claim.
   *
   * The browser comes back from meros.co by navigation, so the token can't be
   * the callback's answer; the page claims it with this code, once, in a call
   * that carries the browser's PIN token like every other.
   */
  hold(result: SignedIn, persistent: boolean): string {
    const now = Date.now();
    for (const [code, claim] of this.claims) if (claim.expiresAt < now) this.claims.delete(code);
    const code = crypto.randomBytes(24).toString('base64url');
    this.claims.set(code, { result, persistent, expiresAt: now + CLAIM_MS });
    return code;
  }

  async claim(code: string): Promise<PersonSignIn | null> {
    const claim = this.claims.get(code);
    this.claims.delete(code);
    if (!claim || claim.expiresAt < Date.now()) return null;
    return this.issue(claim.result, claim.persistent);
  }

  /** The person a browser's token names, or null when it names nobody (any more). */
  async resolve(token: string | undefined): Promise<Person | null> {
    if (!token) return null;
    const row = await prisma.personToken.findUnique({ where: { tokenHash: hash(token) } });
    if (!row) return null;
    const idle = row.persistent ? IDLE_MS.machine : IDLE_MS.tab;
    if (Date.now() - row.lastUsedAt.getTime() > idle) {
      await prisma.personToken.delete({ where: { tokenHash: row.tokenHash } }).catch(() => {});
      return null;
    }
    await prisma.personToken.update({ where: { tokenHash: row.tokenHash }, data: { lastUsedAt: new Date() } });
    return { sub: row.sub, session: row.session, name: row.name, email: row.email, persistent: row.persistent };
  }

  /** Run a command as the person, ending their sign-in here if Meros has. */
  private async run<T>(person: Person, command: string, input: Record<string, unknown>): Promise<T> {
    try {
      return await this.meros.run<T>(command, input, this.session(person.session));
    } catch (err) {
      const code = err instanceof CloudRefused || err instanceof CloudLocalState ? err.code : null;
      if (code && ENDED.has(code)) {
        await this.forget(person.sub);
        throw new PersonSignedOut();
      }
      throw err;
    }
  }

  async profile(person: Person): Promise<{ keys: Record<string, unknown>; key_meta: Record<string, string> }> {
    const res = await this.run<{ keys: Record<string, unknown>; updated: Record<string, string> }>(
      person, 'cloud.profile.get', { namespace: PROFILE_NAMESPACE },
    );
    return { keys: res.keys ?? {}, key_meta: res.updated ?? {} };
  }

  async putProfile(person: Person, keys: Record<string, unknown>) {
    const res = await this.run<{ keys: Record<string, unknown>; updated: Record<string, string> }>(
      person, 'cloud.profile.put', { namespace: PROFILE_NAMESPACE, keys },
    );
    return { keys: res.keys ?? {}, key_meta: res.updated ?? {} };
  }

  /**
   * Sign the person out: the helper revokes at Meros (or forgets the session
   * anyway when Meros can't be reached), and every browser signed in as them
   * here is signed out with it.
   */
  async signOut(person: Person): Promise<void> {
    try {
      await this.meros.run('signin.signout', {}, this.session(person.session));
    } catch (err) {
      log.warn(`[Cloud] Signing ${person.email ?? person.sub} out: ${(err as Error).message}`);
    }
    await this.forget(person.sub);
    log.info(`[Cloud] ${person.email ?? person.sub} signed out of preference sync`);
  }

  private async forget(sub: string): Promise<void> {
    await prisma.personToken.deleteMany({ where: { sub } });
  }
}
