import { afterEach, describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  hasSecret,
  hashPassword,
  isEncrypted,
  maskSecret,
  verifyPassword,
} from './crypto.js';

const ORIGINAL = process.env.BUTLER_SECRET;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BUTLER_SECRET;
  else process.env.BUTLER_SECRET = ORIGINAL;
});

describe('secret storage', () => {
  it('round-trips a key when a secret is configured', () => {
    process.env.BUTLER_SECRET = 'correct horse battery staple';
    const sealed = encryptSecret('abs-api-key-value');
    expect(isEncrypted(sealed)).toBe(true);
    expect(sealed).not.toContain('abs-api-key-value');
    expect(decryptSecret(sealed)).toBe('abs-api-key-value');
  });

  it('produces different ciphertext each time, so equal keys are not linkable', () => {
    process.env.BUTLER_SECRET = 'secret';
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('stores plaintext behind an explicit marker when no secret is set', () => {
    delete process.env.BUTLER_SECRET;
    expect(hasSecret()).toBe(false);
    const stored = encryptSecret('visible-key');
    expect(isEncrypted(stored)).toBe(false);
    expect(decryptSecret(stored)).toBe('visible-key');
  });

  it('fails loudly when the secret changed rather than returning garbage', () => {
    process.env.BUTLER_SECRET = 'first-secret';
    const sealed = encryptSecret('abs-key');
    process.env.BUTLER_SECRET = 'different-secret';
    expect(() => decryptSecret(sealed)).toThrow(/BUTLER_SECRET has probably changed/);
  });

  it('explains itself when the secret was removed entirely', () => {
    process.env.BUTLER_SECRET = 'a-secret';
    const sealed = encryptSecret('abs-key');
    delete process.env.BUTLER_SECRET;
    expect(() => decryptSecret(sealed)).toThrow(/BUTLER_SECRET is not set/);
  });

  it('reads back values written before this scheme existed', () => {
    delete process.env.BUTLER_SECRET;
    expect(decryptSecret('bare-legacy-key')).toBe('bare-legacy-key');
  });
});

describe('maskSecret', () => {
  it('shows enough to recognize a key without revealing it', () => {
    expect(maskSecret('abcd12345678wxyz')).toBe('abcd••••wxyz');
    expect(maskSecret('short')).toBe('••••');
  });
});

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', () => {
    const stored = hashPassword('hunter2');
    expect(stored).not.toContain('hunter2');
    expect(verifyPassword('hunter2', stored)).toBe(true);
    expect(verifyPassword('hunter3', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('rejects malformed stored hashes instead of throwing', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
  });
});
