import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Load `.env.local` for development, if there is one.
 *
 * Production does not use this: systemd supplies the environment through the
 * `Environment=` lines the installer writes, which is where `PORT`, `HOST` and
 * `DATABASE_URL` already come from. This exists so a developer can put their
 * Meros client id and signing key somewhere gitignored instead of exporting
 * four variables into every shell.
 *
 * `apps/server/.env` is *tracked* and read by the Prisma CLI, so nothing
 * environment-specific belongs in it. `.env.local` is gitignored, and this is
 * its only reader.
 *
 * Node's own loader, so there is no dotenv dependency. Values already present
 * in the real environment win — `process.loadEnvFile` does not overwrite them,
 * which is the behaviour we want: an explicit `MEROS_BASE_URL=… pnpm dev`
 * should beat the file.
 */
export function loadLocalEnv(cwd: string = process.cwd()): string | null {
  // Resolved against both the package directory and the repository root, because
  // the server is started from either depending on whether it is `pnpm dev`, a
  // test, or the packaged desktop build.
  for (const candidate of [
    join(cwd, '.env.local'),
    join(cwd, 'apps', 'server', '.env.local'),
    join(__dirname, '..', '.env.local'),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      process.loadEnvFile(candidate);
      return candidate;
    } catch {
      // A malformed file should not stop the server booting: the cloud is
      // optional, and everything else has a default.
      return null;
    }
  }
  return null;
}
