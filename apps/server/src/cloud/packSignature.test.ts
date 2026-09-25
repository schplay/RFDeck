import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { verifySignedPack, PackVerifyError } from './packSignature';

// Meros's own worked vector, under a throwaway demo key. This is the anchor: if
// it stops passing, our understanding of the signature scheme has drifted from
// the cloud's, and that is worth knowing before a venue finds out.
const vector = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'pack-signature.vector.json'), 'utf8'),
);

const demoKeys = () =>
  new Map([['rfdeck-demo', Buffer.from(vector.publicKeyBase64Url, 'base64url')]]);

const response = () => ({ signed: vector.signed, signature: vector.signatureBase64Url });

describe('verifySignedPack', () => {
  it('verifies the vector Meros supplied', () => {
    const { header, payload } = verifySignedPack<any>(response(), demoKeys());
    expect(header).toEqual(vector.expected.header);
    expect(payload.cell).toBe(vector.expected.payloadCell);
    expect(payload.channel_plan).toBe(vector.expected.payloadChannelPlan);
    expect(payload.stations).toHaveLength(vector.expected.payloadStationCount);
    expect(payload.stations[0].rf_channel).toBe(vector.expected.payloadFirstStationRfChannel);
  });

  it('reads the payload from inside `signed`, not from the response field', () => {
    // A response whose convenience `payload` disagrees with what was signed must
    // not be able to influence the result. This is the whole reason the payload
    // is decoded out of the verified string.
    const tampered = { ...response(), payload: { cell: 'tn00e000', stations: [] } };
    const { payload } = verifySignedPack<any>(tampered, demoKeys());
    expect(payload.cell).toBe(vector.expected.payloadCell);
    expect(payload.stations).toHaveLength(1);
  });

  it('rejects a flipped byte anywhere in the signed string', () => {
    const last = vector.signed.at(-1);
    const bad = vector.signed.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect(() => verifySignedPack({ ...response(), signed: bad }, demoKeys()))
      .toThrowError(/does not verify/);
  });

  it('rejects a signature from a different key', () => {
    const other = crypto.generateKeyPairSync('ed25519');
    const forged = crypto.sign(null, Buffer.from(vector.signed, 'utf8'), other.privateKey);
    expect(() => verifySignedPack({ ...response(), signature: forged.toString('base64url') }, demoKeys()))
      .toThrowError(/does not verify/);
  });

  it('refuses an unknown kid by name, rather than trying a key it has', () => {
    // Rotation is additive, so "I do not have that key yet" is a real state and
    // the message has to say which key was wanted.
    const keys = new Map([['rfdeck-2026a', Buffer.from(vector.publicKeyBase64Url, 'base64url')]]);
    try {
      verifySignedPack(response(), keys);
      expect.unreachable('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(PackVerifyError);
      expect((err as PackVerifyError).code).toBe('unknown_kid');
      expect((err as Error).message).toContain('rfdeck-demo');
      expect((err as Error).message).toContain('rfdeck-2026a');
    }
  });

  it('says so when no keys are configured at all', () => {
    try {
      verifySignedPack(response(), new Map());
      expect.unreachable('should have refused');
    } catch (err) {
      expect((err as PackVerifyError).code).toBe('unknown_kid');
      expect((err as Error).message).toMatch(/MEROS_PACK_KEYS/);
    }
  });

  it('rejects anything that is not a signed pack', () => {
    for (const bad of [
      {},
      { signed: vector.signed },
      { signature: vector.signatureBase64Url },
      { signed: 42, signature: 'x' },
      { signed: 'NOTMEROS.a.b', signature: 'x' },
      { signed: 'MEROSPACK1.onlytwo', signature: 'x' },
    ]) {
      expect(() => verifySignedPack(bad as any, demoKeys())).toThrowError(PackVerifyError);
    }
  });

  it('will not be talked into verifying by a header with no kid', () => {
    const header = Buffer.from(JSON.stringify({ product: 'rfdeck' })).toString('base64url');
    const signed = `MEROSPACK1.${header}.${Buffer.from('{}').toString('base64url')}`;
    expect(() => verifySignedPack({ signed, signature: 'x' }, demoKeys()))
      .toThrowError(/no `kid`/);
  });
});
