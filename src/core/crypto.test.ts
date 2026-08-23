import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  isEncrypted,
  keyFilePath,
  keySource,
  maskSecret,
  resetKeyCache,
  upgradeStoredSecret,
  verifyPassword,
} from './crypto.js';

const ORIGINAL_SECRET = process.env.BUTLER_SECRET;
const ORIGINAL_DATA_DIR = process.env.BUTLER_DATA_DIR;

beforeEach(() => {
  // A fresh data dir per test, so a generated key never leaks between them.
  process.env.BUTLER_DATA_DIR = mkdtempSync(join(tmpdir(), 'abs-butler-crypto-'));
  delete process.env.BUTLER_SECRET;
  resetKeyCache();
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.BUTLER_SECRET;
  else process.env.BUTLER_SECRET = ORIGINAL_SECRET;
  process.env.BUTLER_DATA_DIR = ORIGINAL_DATA_DIR;
  resetKeyCache();
});

describe('key file', () => {
  it('generates a key on first use, so encryption needs no configuration', () => {
    expect(existsSync(keyFilePath())).toBe(false);

    const sealed = encryptSecret('abs-api-key-value');

    expect(isEncrypted(sealed)).toBe(true);
    expect(existsSync(keyFilePath())).toBe(true);
    expect(keySource()).toBe('file');
    expect(decryptSecret(sealed)).toBe('abs-api-key-value');
  });

  it('writes the key readable only by its owner', () => {
    encryptSecret('anything');
    expect(statSync(keyFilePath()).mode & 0o777).toBe(0o600);
  });

  it('reuses the key across processes, so stored values survive a restart', () => {
    const sealed = encryptSecret('abs-api-key-value');
    resetKeyCache(); // as if the process restarted
    expect(decryptSecret(sealed)).toBe('abs-api-key-value');
  });

  it('is not created merely by reading a value that needs no key', () => {
    expect(decryptSecret('plain:visible')).toBe('visible');
    expect(decryptSecret('bare-legacy-key')).toBe('bare-legacy-key');
    expect(existsSync(keyFilePath())).toBe(false);
  });
});

describe('BUTLER_SECRET override', () => {
  it('takes precedence and writes no key file', () => {
    process.env.BUTLER_SECRET = 'correct horse battery staple';
    resetKeyCache();

    const sealed = encryptSecret('abs-api-key-value');

    expect(keySource()).toBe('env');
    expect(existsSync(keyFilePath())).toBe(false);
    expect(decryptSecret(sealed)).toBe('abs-api-key-value');
  });

  it('fails loudly when it changed rather than returning garbage', () => {
    process.env.BUTLER_SECRET = 'first-secret';
    resetKeyCache();
    const sealed = encryptSecret('abs-key');

    process.env.BUTLER_SECRET = 'different-secret';
    resetKeyCache();
    expect(() => decryptSecret(sealed)).toThrow(/BUTLER_SECRET has changed/);
  });
});

describe('secret storage', () => {
  it('produces different ciphertext each time, so equal keys are not linkable', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('reads back values written before this scheme existed', () => {
    expect(decryptSecret('plain:visible-key')).toBe('visible-key');
    expect(decryptSecret('bare-legacy-key')).toBe('bare-legacy-key');
  });

  it('re-seals a legacy plaintext value, and leaves a sealed one alone', () => {
    const upgraded = upgradeStoredSecret('plain:visible-key');
    expect(upgraded).not.toBeNull();
    expect(isEncrypted(upgraded!)).toBe(true);
    expect(decryptSecret(upgraded!)).toBe('visible-key');

    expect(upgradeStoredSecret(upgraded!)).toBeNull();
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
