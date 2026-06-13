import { PrismaClient } from '@prisma/client';
import path from 'path';

// Resolve an absolute path to the database file to avoid CWD issues in monorepo/Electron
// In dist/, __dirname is apps/server/dist, so we go up one dir to apps/server, then into prisma/
const dbPath = path.resolve(__dirname, '../prisma/rfdeck.db');
const dbUrl = `file:${dbPath.replace(/\\/g, '/')}`;

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: dbUrl,
    },
  },
});
