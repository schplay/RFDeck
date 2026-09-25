import crypto from 'crypto';

/**
 * Verifying a Meros signed pack.
 *
 * The payload is never signed in isolation — the feed wraps it, and the server
 * hands over the exact string it signed. So there is no canonicalisation here,
 * no key sorting and no re-serialising: the message is the raw ASCII bytes of
 * the `signed` field, exactly as received.
 *
 *   signed = "MEROSPACK1.<base64url(header)>.<base64url(payload)>"
 *   verify = Ed25519(base64url_decode(signature), utf8(signed), publicKey)
 *
 * Two rules that matter more than the mechanics:
 *
 *   1. The payload is read **out of `signed`**, never out of the response's
 *      convenience `payload` field. If we parsed that instead, what the
 *      application used could drift from what was actually verified — the gap
 *      between "the signature checked out" and "this is the data it covered".
 *   2. The `kid` lives inside the signed header, so a swapped `kid` fails
 *      verification rather than quietly selecting a different key. It is read
 *      from the decoded header and looked up; an unknown one is refused by name.
 *
 * The same construction signs entitlement statements, the feed index and every
 * cell, so this one verifier covers all of them.
 */

export const PACK_TAG = 'MEROSPACK1';

/** The header Meros signs alongside the payload. */
export interface PackHeader {
  product: string;
  pack: string;
  version: number;
  kid: string;
  issued_at: string;
}

/** What a feed endpoint returns. `payload` is a convenience we deliberately ignore. */
export interface SignedPackResponse {
  signed?: unknown;
  signature?: unknown;
  [key: string]: unknown;
}

export interface VerifiedPack<T = unknown> {
  header: PackHeader;
  payload: T;
}

export class PackVerifyError extends Error {
  constructor(message: string, readonly code: PackVerifyErrorCode) {
    super(message);
    this.name = 'PackVerifyError';
  }
}

export type PackVerifyErrorCode =
  | 'malformed'        // not a signed pack at all
  | 'unknown_kid'      // signed by a key this build does not have
  | 'bad_signature'    // the signature does not check out
  | 'bad_payload';     // verified, but the segments are not the JSON they claim

function decodeSegment(segment: string, what: string): any {
  let text: string;
  try {
    text = Buffer.from(segment, 'base64url').toString('utf8');
  } catch {
    throw new PackVerifyError(`Pack ${what} is not valid base64url`, 'bad_payload');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PackVerifyError(`Pack ${what} is not valid JSON`, 'bad_payload');
  }
}

/**
 * Verify a signed pack and return what it actually covered.
 *
 * @param response The parsed feed response.
 * @param keys     Meros's public keys by `kid`, from `MEROS_PACK_KEYS`.
 */
export function verifySignedPack<T = unknown>(
  response: SignedPackResponse,
  keys: Map<string, Buffer>,
): VerifiedPack<T> {
  const signed = response?.signed;
  const signature = response?.signature;
  if (typeof signed !== 'string' || typeof signature !== 'string') {
    throw new PackVerifyError(
      'Not a signed pack: `signed` and `signature` must both be strings',
      'malformed',
    );
  }

  const segments = signed.split('.');
  if (segments.length !== 3 || segments[0] !== PACK_TAG) {
    throw new PackVerifyError(
      `Unrecognised pack envelope — expected "${PACK_TAG}.<header>.<payload>"`,
      'malformed',
    );
  }

  // The kid comes from inside the signed header, so choosing the key cannot be
  // influenced by anything outside the signature's coverage.
  const header = decodeSegment(segments[1], 'header') as PackHeader;
  if (!header || typeof header.kid !== 'string' || !header.kid) {
    throw new PackVerifyError('Pack header carries no `kid`', 'malformed');
  }

  const raw = keys.get(header.kid);
  if (!raw) {
    const known = [...keys.keys()];
    throw new PackVerifyError(
      `Pack is signed with key "${header.kid}", which this build does not have. ` +
      (known.length
        ? `Known keys: ${known.join(', ')}. Meros rotates additively, so a newer key ` +
          `needs adding to MEROS_PACK_KEYS.`
        : `No signing keys are configured — set MEROS_PACK_KEYS.`),
      'unknown_kid',
    );
  }

  const publicKey = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') } as any,
    format: 'jwk',
  });

  const ok = crypto.verify(
    null,
    Buffer.from(signed, 'utf8'),
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
  if (!ok) {
    throw new PackVerifyError(
      `Signature does not verify for pack "${header.pack}" under key "${header.kid}"`,
      'bad_signature',
    );
  }

  // Only now is the payload read, and only from inside the string that was
  // verified.
  const payload = decodeSegment(segments[2], 'payload') as T;
  return { header, payload };
}
