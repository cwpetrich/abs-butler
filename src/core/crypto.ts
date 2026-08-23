import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { resolveDataDir } from '../db/index.js';

/**
 * Encryption for the AudiobookShelf API key at rest.
 *
 * The key lives in `secret.key` beside the database, generated on first use, so
 * encryption is on by default with nothing to configure. It is deliberately not
 * stored *in* the database: a key sitting next to its own ciphertext is
 * obfuscation, not encryption, and the point is that a copy of the database —
 * a backup, a support bundle — is not a copy of your credentials.
 *
 * BUTLER_SECRET still works and takes precedence, for anyone managing secrets
 * externally (Docker secrets, Kubernetes, a password manager).
 */

const ENC_PREFIX = 'enc:v1:';
const PLAIN_PREFIX = 'plain:';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const KEY_FILE = 'secret.key';

export type KeySource = 'env' | 'file';

/** Cached because scrypt is intentionally slow and the file never changes mid-process. */
let cached: { secret: string; source: KeySource } | undefined;

export function keyFilePath(): string {
  return join(resolveDataDir(), KEY_FILE);
}

function readKeyFile(): string | null {
  try {
    const contents = readFileSync(keyFilePath(), 'utf8').trim();
    return contents.length > 0 ? contents : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Could not read the encryption key at ${keyFilePath()}: ${(err as Error).message}`,
    );
  }
}

/**
 * Writes the key with owner-only permissions.
 *
 * `wx` on first creation so two processes starting at once cannot each generate
 * a key and have the loser silently orphan the winner's ciphertext.
 */
function writeKeyFile(secret: string, { overwrite = false } = {}): string | null {
  const path = keyFilePath();
  try {
    writeFileSync(path, `${secret}\n`, { mode: 0o600, flag: overwrite ? 'w' : 'wx' });
    chmodSync(path, 0o600);
    return null;
  } catch (err) {
    if (!overwrite && (err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another process won the race; adopt its key rather than ours.
      return readKeyFile();
    }
    throw new Error(`Could not write the encryption key to ${path}: ${(err as Error).message}`);
  }
}

/** The passphrase in force, generating and persisting one on first use. */
function currentSecret(): { secret: string; source: KeySource } {
  if (cached) return cached;

  const fromEnv = process.env.BUTLER_SECRET?.trim();
  if (fromEnv) {
    cached = { secret: fromEnv, source: 'env' };
    return cached;
  }

  const existing = readKeyFile();
  if (existing) {
    cached = { secret: existing, source: 'file' };
    return cached;
  }

  const generated = randomBytes(32).toString('base64');
  const adopted = writeKeyFile(generated);
  cached = { secret: adopted ?? generated, source: 'file' };
  return cached;
}

/** Where the key comes from, for reporting in the UI. */
export function keySource(): KeySource {
  return currentSecret().source;
}

/** True once a key exists, which is always — kept for call sites that ask. */
export function hasSecret(): boolean {
  return currentSecret().secret.length > 0;
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, KEY_LENGTH);
}

/**
 * The salt is stored alongside the ciphertext rather than in settings, so a
 * database row is self-describing and a rotated key fails loudly instead of
 * decrypting to garbage.
 */
export function encryptSecret(plaintext: string, secret?: string): string {
  const key = secret ?? currentSecret().secret;
  const salt = randomBytes(16);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ENC_PREFIX + Buffer.concat([salt, iv, tag, ciphertext]).toString('base64');
}

export function decryptSecret(stored: string, secret?: string): string {
  // Written before a key was always available, or by an install that never set
  // BUTLER_SECRET. Still readable; upgradeStoredSecret re-seals it.
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
  if (!stored.startsWith(ENC_PREFIX)) return stored;

  // Resolved only now, so an install with nothing encrypted yet never causes a
  // key file to be generated just by being read.
  const key = secret ?? currentSecret().secret;
  const raw = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
  const salt = raw.subarray(0, 16);
  const iv = raw.subarray(16, 16 + IV_LENGTH);
  const tag = raw.subarray(16 + IV_LENGTH, 16 + IV_LENGTH + 16);
  const ciphertext = raw.subarray(16 + IV_LENGTH + 16);

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(key, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(
      keySource() === 'env'
        ? 'Could not decrypt the API key — BUTLER_SECRET has changed since it was saved. ' +
          'Restore the previous value, or re-enter the API key to store it under the current one.'
        : `Could not decrypt the API key — ${keyFilePath()} does not match the stored key. ` +
          'Restore that file from a backup, or re-enter the API key.',
    );
  }
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX);
}

/** Re-seals a value written before an encryption key existed. */
export function upgradeStoredSecret(stored: string): string | null {
  if (isEncrypted(stored)) return null;
  return encryptSecret(decryptSecret(stored));
}

/**
 * Generates a new key and returns it without installing it.
 *
 * Rotation is a two-step dance on purpose: the caller re-encrypts everything
 * under the new key first and only then calls commitRotation, so a failure
 * midway leaves the old key file — and therefore the existing ciphertext —
 * intact. Changing the key out from under stored data is the one way to lose it.
 */
export function beginRotation(): { secret: string; previous: string } {
  return { secret: randomBytes(32).toString('base64'), previous: currentSecret().secret };
}

export function commitRotation(secret: string): void {
  if (process.env.BUTLER_SECRET?.trim()) {
    throw new Error(
      'BUTLER_SECRET is set, so the key is managed outside abs-butler and cannot be rotated here. ' +
        'Change the environment variable and re-enter the API key instead.',
    );
  }
  writeKeyFile(secret, { overwrite: true });
  cached = { secret, source: 'file' };
}

/** Shows enough of a key to recognize it without revealing it. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/** Test seam: forget the cached key so a different data dir can be used. */
export function resetKeyCache(): void {
  cached = undefined;
}

// ---------------------------------------------------------------------------
// Web UI password hashing
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
