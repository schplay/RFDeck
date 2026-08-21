import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { log } from '../logger';

// Encryption at rest for device passwords.
//
// These passwords unlock the wireless hardware itself, and the SQLite file is
// readable by anyone with filesystem access — on a shared venue machine that is
// a real exposure. AES-256-GCM so tampering is detectable, not just unreadable.
//
// The key lives beside the database rather than in the database, so copying the
// .db file alone does not carry the secrets with it. This protects against
// casual exposure (a backup, a shared drive, a support bundle), not against an
// attacker who already has full access to the host — that would need an
// operator-supplied passphrase, which is the wrong trade for unattended
// show-day startup where nobody is present to type one.

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

function keyPath(): string {
  // Sit next to the SQLite file so key and data stay together for the app but
  // separate for anyone who only copies the database.
  const url = process.env.DATABASE_URL ?? '';
  const match = url.match(/^file:(.+)$/);
  if (match) {
    const dbPath = path.resolve(process.cwd(), match[1]);
    return path.join(path.dirname(dbPath), '.rfdeck-key');
  }
  return path.join(os.homedir(), '.rfdeck-key');
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  const file = keyPath();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').trim();
      const key = Buffer.from(raw, 'hex');
      if (key.length === 32) {
        cachedKey = key;
        return key;
      }
      log.warn('[secretBox] Key file is malformed; generating a new one');
    }
  } catch (err: any) {
    log.warn('[secretBox] Could not read key file:', err?.message);
  }

  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  } catch (err: any) {
    // Non-fatal: encryption still works this session, but stored values will
    // be unreadable after a restart. Loud, because it needs fixing.
    log.error('[secretBox] Could not persist encryption key:', err?.message);
  }
  cachedKey = key;
  return key;
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plain: string | null): string | null {
  if (plain === null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, loadKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored: string | null): string | null {
  if (stored === null || stored === '') return null;

  // Values written before encryption was introduced are plaintext. Return them
  // as-is so existing installs keep working; they are re-encrypted on next save.
  if (!isEncrypted(stored)) return stored;

  try {
    const [, , ivB64, tagB64, dataB64] = stored.split(':');
    const decipher = crypto.createDecipheriv(ALGO, loadKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (err: any) {
    // Usually a lost or replaced key file. Fail soft: the device shows as
    // needing its password re-entered rather than the server refusing to start.
    log.error('[secretBox] Could not decrypt a stored secret:', err?.message);
    return null;
  }
}
