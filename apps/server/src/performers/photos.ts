import fs from 'fs';
import path from 'path';

// Headshot storage.
//
// Files on disk with a path reference in the database, beside the database
// itself — the same rule as recording clips. Blobs in SQLite would bloat every
// query that touches the roster, and a directory next to the data travels with
// a backup of that directory.
//
// Images arrive already resized by the client and are written verbatim. The
// server does no image processing, which keeps a native imaging dependency out
// of a deployment that has to build on a bare Ubuntu box.

/** Formats a browser will render inline and which cover what a camera produces. */
const ALLOWED = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png',  'png'],
  ['image/webp', 'webp'],
]);

/** Generous for a resized headshot; a full-resolution photo is rejected. */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

export function resolveImagesDir(): string {
  const url = process.env.DATABASE_URL ?? '';
  const match = url.match(/^file:(.+)$/);
  if (match) {
    const dbPath = path.resolve(process.cwd(), match[1]);
    return path.join(path.dirname(dbPath), 'images');
  }
  return path.resolve(__dirname, '../../prisma/images');
}

export interface DecodedImage {
  bytes: Buffer;
  extension: string;
  contentType: string;
}

/**
 * Decode a `data:` URL into bytes, rejecting anything that is not an image we
 * are willing to serve back.
 *
 * Serving an arbitrary uploaded type inline is how a "photo" becomes a script
 * someone else's browser runs, so the allow-list is on the way in and the
 * content type on the way out is ours, never the uploader's.
 */
export function decodeDataUrl(dataUrl: unknown): DecodedImage | { error: string } {
  if (typeof dataUrl !== 'string') return { error: 'No image supplied' };

  const match = dataUrl.match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return { error: 'Expected a base64 data URL' };

  const contentType = match[1].toLowerCase();
  const extension = ALLOWED.get(contentType);
  if (!extension) {
    return { error: `Unsupported image type ${contentType}. Use JPEG, PNG or WebP.` };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  } catch {
    return { error: 'The image data could not be decoded' };
  }
  if (bytes.length === 0) return { error: 'The image was empty' };
  if (bytes.length > MAX_PHOTO_BYTES) {
    return { error: `Image is ${Math.round(bytes.length / 1024)} KB; the limit is ${MAX_PHOTO_BYTES / 1024 / 1024} MB` };
  }

  return { bytes, extension, contentType };
}

export function contentTypeFor(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  for (const [type, e] of ALLOWED) if (e === ext) return type;
  return 'application/octet-stream';
}

/**
 * Absolute path for a stored photo, or null.
 *
 * The stored value only ever comes from our own rows, but a path separator in
 * one would let a crafted value escape the images directory, so it is refused
 * rather than trusted.
 */
export function photoFile(filename: string | null | undefined): string | null {
  if (!filename) return null;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null;
  const full = path.join(resolveImagesDir(), filename);
  return fs.existsSync(full) ? full : null;
}
