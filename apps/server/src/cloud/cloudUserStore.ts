import { prisma } from '../db';

/**
 * Who is signed in on this install as a cloud user, and since when.
 *
 * Display only: the session itself, its refresh token included, is the
 * meros-client helper's. This keeps what the helper does not report — how the
 * person signed in and when — so Settings → Cloud can say it.
 */
export interface CloudUserRecord {
  sub: string;
  name: string | null;
  email: string | null;
  signedInVia: string;
  signedInAt: Date;
}

export interface CloudUserStore {
  read(): Promise<CloudUserRecord | null>;
  /** Record this user, replacing whoever was recorded before. */
  signIn(user: { sub: string; name: string | null; email: string | null; signedInVia: string }): Promise<void>;
  clear(): Promise<void>;
}

export class PrismaCloudUserStore implements CloudUserStore {
  async read(): Promise<CloudUserRecord | null> {
    const row = await prisma.cloudUser.findFirst();
    return row ? { sub: row.sub, name: row.name, email: row.email, signedInVia: row.signedInVia, signedInAt: row.signedInAt } : null;
  }

  async signIn(user: { sub: string; name: string | null; email: string | null; signedInVia: string }): Promise<void> {
    await prisma.$transaction([
      prisma.cloudUser.deleteMany({ where: { NOT: { sub: user.sub } } }),
      prisma.cloudUser.upsert({
        where: { sub: user.sub },
        // No refresh token: it lives in the helper's state, never in the database.
        create: { ...user, refreshToken: null, signedInAt: new Date() },
        update: { ...user, refreshToken: null, signedInAt: new Date() },
      }),
    ]);
  }

  async clear(): Promise<void> {
    await prisma.cloudUser.deleteMany({});
  }
}

/** In memory, for tests. */
export class MemoryCloudUserStore implements CloudUserStore {
  private user: CloudUserRecord | null = null;

  async read() { return this.user ? { ...this.user } : null; }

  async signIn(user: { sub: string; name: string | null; email: string | null; signedInVia: string }) {
    this.user = { ...user, signedInAt: new Date() };
  }

  async clear() { this.user = null; }
}
