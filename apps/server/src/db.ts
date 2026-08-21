import { PrismaClient } from '@prisma/client';
import path from 'path';

// Where the database lives, in priority order:
//
//   1. DATABASE_URL from the environment. This is how the desktop app points at
//      the per-user data directory (the install directory is read-only under
//      Program Files) and how a headless deployment picks its own location.
//
//   2. A path resolved from this file. In dist/ that is apps/server/prisma,
//      which is the right answer for development and for `pnpm start` from the
//      server directory.
//
// Resolved to an absolute path either way: a relative SQLite URL is interpreted
// relative to the process working directory, so running the server from a
// different directory would silently open — or create — a different, empty
// database rather than failing.
function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) {
    // Absolute file: URLs pass through. A relative one is resolved against the
    // working directory now, so it cannot drift later.
    const match = fromEnv.match(/^file:(.*)$/);
    if (!match) return fromEnv; // non-SQLite provider; hand it over untouched
    const target = match[1];
    if (path.isAbsolute(target)) return `file:${target.replace(/\\/g, '/')}`;
    return `file:${path.resolve(process.cwd(), target).replace(/\\/g, '/')}`;
  }

  const dbPath = path.resolve(__dirname, '../prisma/rfdeck.db');
  return `file:${dbPath.replace(/\\/g, '/')}`;
}

const dbUrl = resolveDatabaseUrl();
console.log(`[Prisma] Using database ${dbUrl}`);

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: dbUrl,
    },
  },
});
