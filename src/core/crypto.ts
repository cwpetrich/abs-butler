import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Encryption for AudiobookShelf API keys at rest.
 *
 * With BUTLER_SECRET set, keys are sealed with AES-256-GCM so a copy of the
 * database is not a copy of your credentials. Without it, keys are stored in
 * plaintext behind an explicit `plain:` marker — visible in the UI and logged
 * at startup, so an unprotected install is never a silent one.
 */

const ENC_PREFIX = 'enc:v1:';
const PLAIN_PREFIX = 'plain:';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

export function hasSecret(): boolean {
  return Boolean(process.env.BUTLER_SECRET && process.env.BUTLER_SECRET.length > 0);
}

function deriveKey(salt: Buffer): Buffer {
  const secret = process.env.BUTLER_SECRET;
  if (!secret) throw new Error('BUTLER_SECRET is not set');
  return scryptSync(secret, salt, KEY_LENGTH);
}

/**
 * The salt is stored alongside the ciphertext rather than in settings, so a
 * database row is self-describing and a rotated secret fails loudly instead of
 * decrypting to garbage.
 */
export function encryptSecret(plaintext: string): string {
  if (!hasSecret()) return PLAIN_PREFIX + plaintext;

  const salt = randomBytes(16);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ENC_PREFIX + Buffer.concat([salt, iv, tag, ciphertext]).toString('base64');
}

export function decryptSecret(stored: string): string {
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);

  if (!stored.startsWith(ENC_PREFIX)) {
    // Anything unprefixed predates this scheme; treat it as plaintext.
    return stored;
  }
  if (!hasSecret()) {
    throw new Error(
      'This API key is encrypted but BUTLER_SECRET is not set. ' +
        'Set it to the same value used when the key was saved.',
    );
  }

  const raw = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
  const salt = raw.subarray(0, 16);
  const iv = raw.subarray(16, 16 + IV_LENGTH);
  const tag = raw.subarray(16 + IV_LENGTH, 16 + IV_LENGTH + 16);
  const ciphertext = raw.subarray(16 + IV_LENGTH + 16);

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(
      'Could not decrypt an API key — BUTLER_SECRET has probably changed since it was saved. ' +
        'Re-add the server to store the key under the current secret.',
    );
  }
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(ENC_PREFIX);
}

/** Shows enough of a key to recognize it without revealing it. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
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
