import type { Db } from './index.js';
import {
  beginRotation,
  commitRotation,
  decryptSecret,
  encryptSecret,
  isEncrypted,
  upgradeStoredSecret,
} from '../core/crypto.js';

/**
 * The single AudiobookShelf connection.
 *
 * abs-butler manages exactly one server, co-located with it. The table is
 * pinned to one row by a CHECK constraint rather than by convention, so there
 * is no such thing as a second connection to disagree about.
 */
export interface ConnectionRecord {
  url: string;
  /** Where this machine sees the media. Required for `organize`, unused otherwise. */
  libraryRoot: string | null;
  /** The path AudiobookShelf itself reports, when it differs — the usual case when ABS is in Docker. */
  pathPrefix: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The connection plus its decrypted API key. Never send this to the browser. */
export interface ConnectionWithKey extends ConnectionRecord {
  apiKey: string;
}

export interface ConnectionInput {
  url: string;
  apiKey: string;
  libraryRoot?: string | null;
  pathPrefix?: string | null;
}

interface ConnectionRow {
  url: string;
  api_key: string;
  library_root: string | null;
  path_prefix: string | null;
  created_at: number;
  updated_at: number;
}

function toRecord(row: ConnectionRow): ConnectionRecord {
  return {
    url: row.url,
    libraryRoot: row.library_root,
    pathPrefix: row.path_prefix,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed); // throws on garbage, which is what we want
  return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname);
}

function row(db: Db): ConnectionRow | undefined {
  return db.prepare('SELECT * FROM connection WHERE id = 1').get() as unknown as
    | ConnectionRow
    | undefined;
}

export function getConnection(db: Db): ConnectionRecord | null {
  const found = row(db);
  return found ? toRecord(found) : null;
}

export function isConfigured(db: Db): boolean {
  return row(db) !== undefined;
}

export function getConnectionWithKey(db: Db): ConnectionWithKey | null {
  const found = row(db);
  if (!found) return null;
  return { ...toRecord(found), apiKey: decryptSecret(found.api_key) };
}

/** Creates or replaces the connection. */
export function saveConnection(db: Db, input: ConnectionInput): ConnectionRecord {
  const now = Date.now();
  const existing = row(db);
  db.prepare(
    `INSERT INTO connection (id, url, api_key, library_root, path_prefix, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       url = excluded.url,
       api_key = excluded.api_key,
       library_root = excluded.library_root,
       path_prefix = excluded.path_prefix,
       updated_at = excluded.updated_at`,
  ).run(
    normalizeUrl(input.url),
    encryptSecret(input.apiKey),
    input.libraryRoot?.trim() || null,
    input.pathPrefix?.trim() || null,
    existing?.created_at ?? now,
    now,
  );
  return getConnection(db)!;
}

export function updateConnection(db: Db, patch: Partial<ConnectionInput>): ConnectionRecord {
  const existing = getConnection(db);
  if (!existing) throw new Error('No AudiobookShelf connection is configured yet.');

  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  const set = (column: string, value: string | number | null) => {
    fields.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.url !== undefined) set('url', normalizeUrl(patch.url));
  // An empty apiKey means "leave it alone" — the UI never round-trips the real key.
  if (patch.apiKey) set('api_key', encryptSecret(patch.apiKey));
  if (patch.libraryRoot !== undefined) set('library_root', patch.libraryRoot?.trim() || null);
  if (patch.pathPrefix !== undefined) set('path_prefix', patch.pathPrefix?.trim() || null);

  if (fields.length === 0) return existing;
  set('updated_at', Date.now());

  db.prepare(`UPDATE connection SET ${fields.join(', ')} WHERE id = 1`).run(...values);
  return getConnection(db)!;
}

export function deleteConnection(db: Db): void {
  db.prepare('DELETE FROM connection WHERE id = 1').run();
}

/** Whether the stored key is sealed, for surfacing status in the UI. */
export function connectionKeyStatus(db: Db): { encrypted: boolean } {
  const found = row(db);
  return { encrypted: found ? isEncrypted(found.api_key) : false };
}

/**
 * Re-seals a key stored before an encryption key existed.
 *
 * Called at startup: installs that ran without BUTLER_SECRET have a plaintext
 * key on disk, and now that a key file is always available there is no reason
 * to leave it that way.
 */
export function upgradeStoredKey(db: Db): boolean {
  const found = row(db);
  if (!found) return false;
  const upgraded = upgradeStoredSecret(found.api_key);
  if (!upgraded) return false;
  db.prepare('UPDATE connection SET api_key = ? WHERE id = 1').run(upgraded);
  return true;
}

/**
 * Rotates the encryption key, re-encrypting the stored API key under it.
 *
 * The old key file is restored if the database write fails, because a key file
 * that no longer matches the ciphertext beside it is unrecoverable — the whole
 * failure mode this replaces, where changing BUTLER_SECRET silently orphaned
 * the stored key.
 */
export function rotateEncryptionKey(db: Db): void {
  const current = getConnectionWithKey(db);
  const { secret, previous } = beginRotation();

  if (!current) {
    commitRotation(secret);
    return;
  }

  const resealed = encryptSecret(current.apiKey, secret);
  commitRotation(secret);
  try {
    db.prepare('UPDATE connection SET api_key = ?, updated_at = ? WHERE id = 1').run(
      resealed,
      Date.now(),
    );
  } catch (err) {
    commitRotation(previous);
    throw err;
  }
}
