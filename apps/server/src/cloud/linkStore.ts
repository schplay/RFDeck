import { prisma } from '../db';
import { encryptSecret, decryptSecret } from '../auth/secretBox';

/**
 * Where the instance link's refresh token lives.
 *
 * A port rather than direct database access, for one reason that matters and one
 * that is merely convenient. The one that matters: the rotation rules — commit
 * before use, single writer — are properties of *this* interface, so they can be
 * tested honestly against a fake without a database standing in the way, and a
 * future store (a keychain on the desktop, say) inherits them for free. The
 * convenient one: it keeps Prisma out of `link.ts`, which is otherwise pure
 * protocol.
 */
export interface LinkStore {
  /** The stored refresh token in plaintext, or null when not linked. */
  readRefreshToken(): Promise<string | null>;
  /**
   * Persist a rotated refresh token, or clear it with null.
   *
   * Must be durable before it returns. A caller that uses the access token from
   * the same response before this resolves risks presenting a stale refresh
   * token after a crash, and a replayed refresh token does not merely fail — it
   * revokes the whole family and kills the link.
   */
  saveRefreshToken(token: string | null): Promise<void>;
  /** Forget the link entirely: token, account, cached entitlements, timestamps. */
  forgetLink(): Promise<void>;
}

/** The real store: the Settings row, with the token encrypted at rest. */
export class PrismaLinkStore implements LinkStore {
  private async row() {
    const existing = await prisma.settings.findFirst();
    return existing ?? prisma.settings.create({ data: {} });
  }

  async readRefreshToken(): Promise<string | null> {
    const settings = await prisma.settings.findFirst();
    return decryptSecret(settings?.cloudRefreshToken ?? null);
  }

  async saveRefreshToken(token: string | null): Promise<void> {
    const settings = await this.row();
    await prisma.settings.update({
      where: { id: settings.id },
      data: {
        cloudRefreshToken: token === null ? null : encryptSecret(token),
        // Set once, on the first token of a link, and left alone afterwards so
        // "linked since" means what it says across refreshes.
        cloudLinkedAt: token === null ? settings.cloudLinkedAt : (settings.cloudLinkedAt ?? new Date()),
        cloudLastRefreshAt: token === null ? settings.cloudLastRefreshAt : new Date(),
      },
    });
  }

  async forgetLink(): Promise<void> {
    const settings = await prisma.settings.findFirst();
    if (!settings) return;
    await prisma.settings.update({
      where: { id: settings.id },
      data: {
        cloudRefreshToken: null,
        cloudAccountId: null,
        cloudEntitlements: null,
        cloudLinkedAt: null,
        cloudLastRefreshAt: null,
      },
    });
  }
}

/** An in-memory store, for tests and for a fake cloud. */
export class MemoryLinkStore implements LinkStore {
  private token: string | null = null;
  /** Every value ever written, so a test can assert commit-before-use ordering. */
  readonly writes: (string | null)[] = [];

  async readRefreshToken() { return this.token; }

  async saveRefreshToken(token: string | null) {
    this.token = token;
    this.writes.push(token);
  }

  async forgetLink() {
    this.token = null;
    this.writes.push(null);
  }
}

/**
 * Where the cached entitlement statement lives.
 *
 * Separate port for the same reason as the link's: the behaviour worth testing is
 * "keeps answering from cache when Meros is unreachable", and that should be
 * provable without a database. It also records the account id, which is a value
 * RFDeck *learns* from `/v1/entitlements` rather than one the token carries.
 */
export interface EntitlementCache {
  read(): Promise<string | null>;
  write(accountId: string, statement: string): Promise<void>;
}

export class PrismaEntitlementCache implements EntitlementCache {
  async read(): Promise<string | null> {
    const settings = await prisma.settings.findFirst();
    return settings?.cloudEntitlements ?? null;
  }

  async write(accountId: string, statement: string): Promise<void> {
    const settings = await prisma.settings.findFirst();
    if (!settings) return;
    await prisma.settings.update({
      where: { id: settings.id },
      data: { cloudAccountId: accountId, cloudEntitlements: statement },
    });
  }
}

export class MemoryEntitlementCache implements EntitlementCache {
  private statement: string | null = null;
  accountId: string | null = null;

  async read() { return this.statement; }
  async write(accountId: string, statement: string) {
    this.accountId = accountId;
    this.statement = statement;
  }
}
