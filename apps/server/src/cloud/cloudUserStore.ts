import { prisma } from '../db';
import { encryptSecret, decryptSecret } from '../auth/secretBox';

/** A cloud user signed in on this install, as stored. */
export interface StoredCloudUser {
  /** Meros `sub`: the cloud user's stable id. */
  sub: string;
  name: string | null;
  email: string | null;
  signedInVia: string;
  signedInAt: Date;
  lastRefreshAt: Date | null;
  /** In plaintext here; encrypted at rest by the real store. */
  refreshToken: string | null;
}

/**
 * Where the signed-in cloud user and their refresh token live.
 *
 * A port, like the instance link's `LinkStore`, so the rotation rules can be
 * tested against a fake without a database. The same two rules hold:
 *
 *  - **Durable before use.** Every write resolves only once it is on disk. A
 *    rotated refresh token that is used before it is stored is lost on a crash,
 *    and presenting the old one again does not merely fail — Meros treats it as
 *    a replay and revokes the whole family.
 *  - **A separate slot from the instance link.** This is the "RFDeck Cloud User"
 *    client's family; mixing it with the instance link's would let a failure in
 *    one sign the other out.
 */
export interface CloudUserStore {
  read(): Promise<StoredCloudUser | null>;
  /** Sign this user in, replacing whoever was signed in before. */
  signIn(user: { sub: string; name: string | null; email: string | null; signedInVia: string },
         refreshToken: string): Promise<void>;
  /** Persist a rotated refresh token for the user currently signed in. */
  saveRefreshToken(sub: string, refreshToken: string): Promise<void>;
  /** Sign out: forget the user and their tokens. */
  clear(): Promise<void>;
}

export class PrismaCloudUserStore implements CloudUserStore {
  async read(): Promise<StoredCloudUser | null> {
    const row = await prisma.cloudUser.findFirst();
    if (!row) return null;
    return { ...row, refreshToken: decryptSecret(row.refreshToken) };
  }

  async signIn(user: { sub: string; name: string | null; email: string | null; signedInVia: string },
               refreshToken: string): Promise<void> {
    const encrypted = encryptSecret(refreshToken);
    // One cloud user per install: whoever signed in before is replaced, in the
    // same transaction, so there is never a moment with two.
    await prisma.$transaction([
      prisma.cloudUser.deleteMany({ where: { NOT: { sub: user.sub } } }),
      prisma.cloudUser.upsert({
        where: { sub: user.sub },
        create: { ...user, refreshToken: encrypted, signedInAt: new Date(), lastRefreshAt: new Date() },
        update: { ...user, refreshToken: encrypted, signedInAt: new Date(), lastRefreshAt: new Date() },
      }),
    ]);
  }

  async saveRefreshToken(sub: string, refreshToken: string): Promise<void> {
    await prisma.cloudUser.update({
      where: { sub },
      data: { refreshToken: encryptSecret(refreshToken), lastRefreshAt: new Date() },
    });
  }

  async clear(): Promise<void> {
    await prisma.cloudUser.deleteMany({});
  }
}

/** In memory, for tests. Records every refresh token written, in order. */
export class MemoryCloudUserStore implements CloudUserStore {
  private user: StoredCloudUser | null = null;
  readonly writes: (string | null)[] = [];

  async read() { return this.user ? { ...this.user } : null; }

  async signIn(user: { sub: string; name: string | null; email: string | null; signedInVia: string },
               refreshToken: string) {
    this.user = { ...user, signedInAt: new Date(), lastRefreshAt: new Date(), refreshToken };
    this.writes.push(refreshToken);
  }

  async saveRefreshToken(sub: string, refreshToken: string) {
    if (this.user?.sub !== sub) return;
    this.user = { ...this.user, refreshToken, lastRefreshAt: new Date() };
    this.writes.push(refreshToken);
  }

  async clear() {
    this.user = null;
    this.writes.push(null);
  }
}
