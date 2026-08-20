import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, isEncrypted } from './secretBox';

describe('secretBox', () => {
  it('round-trips a secret', () => {
    const enc = encryptSecret('hunter2');
    expect(decryptSecret(enc)).toBe('hunter2');
  });

  it('does not store the plaintext', () => {
    const enc = encryptSecret('hunter2')!;
    expect(enc).not.toContain('hunter2');
    expect(isEncrypted(enc)).toBe(true);
  });

  it('produces different ciphertext each time', () => {
    // A fresh IV per encryption — identical passwords across devices must not
    // produce identical stored values.
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('passes through legacy plaintext unchanged', () => {
    // Values written before encryption existed must keep working; they are
    // re-encrypted the next time the device is saved.
    expect(decryptSecret('legacy-plaintext')).toBe('legacy-plaintext');
    expect(isEncrypted('legacy-plaintext')).toBe(false);
  });

  it('handles null and empty values', () => {
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret('')).toBeNull();
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret('')).toBeNull();
  });

  it('returns null rather than throwing on tampered data', () => {
    // GCM authentication fails; the device shows as needing its password
    // re-entered instead of the server refusing to start.
    const enc = encryptSecret('hunter2')!;
    const tampered = enc.slice(0, -4) + 'AAAA';
    expect(decryptSecret(tampered)).toBeNull();
  });

  it('handles unicode and long values', () => {
    const tricky = 'pässwörd–✓ ' + 'x'.repeat(500);
    expect(decryptSecret(encryptSecret(tricky))).toBe(tricky);
  });
});
