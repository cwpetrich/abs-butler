import type { Db } from './index.js';
import { decryptSecret, encryptSecret, isEncrypted, maskSecret } from '../core/crypto.js';

export interface ServerRecord {
  id: number;
  name: string;
  url: string;
  /** Host path to this server's media, as seen by the machine running abs-butler. */
  libraryRoot: string | null;
  /** The path prefix AudiobookShelf itself reports, when it differs (e.g. in Docker). */
  pathPrefix: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A server plus its decrypted API key. Never send this to the browser. */
export interface ServerWithKey extends ServerRecord {
  apiKey: string;
}

export interface ServerInput {
  name: string;
  url: string;
  apiKey: string;
  libraryRoot?: string | null;
  pathPrefix?: string | null;
  enabled?: boolean;
}

interface ServerRow {
  id: number;
  name: string;
  url: string;
  api_key: string;
  library_root: string | null;
  path_prefix: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

function toRecord(row: ServerRow): ServerRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    libraryRoot: row.library_root,
    pathPrefix: row.path_prefix,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed); // throws on garbage, which is what we want
  return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname);
}

export function listServers(db: Db): ServerRecord[] {
  const rows = db.prepare('SELECT * FROM servers ORDER BY name').all() as unknown as ServerRow[];
  return rows.map(toRecord);
}

export function getServer(db: Db, id: number): ServerRecord | null {
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as unknown as ServerRow | undefined;
  return row ? toRecord(row) : null;
}

/** Resolves by numeric id or by exact/case-insensitive name, so the CLI can take either. */
export function findServer(db: Db, idOrName: string | number): ServerRecord | null {
  if (typeof idOrName === 'number' || /^\d+$/.test(idOrName)) {
    const byId = getServer(db, Number(idOrName));
    if (byId) return byId;
  }
  const row = db
    .prepare('SELECT * FROM servers WHERE name = ? COLLATE NOCASE')
    .get(String(idOrName)) as unknown as ServerRow | undefined;
  return row ? toRecord(row) : null;
}

export function getServerWithKey(db: Db, id: number): ServerWithKey | null {
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as unknown as ServerRow | undefined;
  if (!row) return null;
  return { ...toRecord(row), apiKey: decryptSecret(row.api_key) };
}

export function createServer(db: Db, input: ServerInput): ServerRecord {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO servers (name, url, api_key, library_root, path_prefix, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  try {
    const result = stmt.run(
      input.name.trim(),
      normalizeUrl(input.url),
      encryptSecret(input.apiKey),
      input.libraryRoot?.trim() || null,
      input.pathPrefix?.trim() || null,
      input.enabled === false ? 0 : 1,
      now,
      now,
    );
    return getServer(db, Number(result.lastInsertRowid))!;
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) {
      throw new Error(`A server named "${input.name}" already exists.`);
    }
    throw err;
  }
}

export function updateServer(db: Db, id: number, patch: Partial<ServerInput>): ServerRecord {
  const existing = getServer(db, id);
  if (!existing) throw new Error(`No server with id ${id}`);

  const fields: string[] = [];
  const values: Array<string | number | null> = [];

  const set = (column: string, value: string | number | null) => {
    fields.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.name !== undefined) set('name', patch.name.trim());
  if (patch.url !== undefined) set('url', normalizeUrl(patch.url));
  // An empty apiKey means "leave it alone" — the UI never round-trips the real key.
  if (patch.apiKey) set('api_key', encryptSecret(patch.apiKey));
  if (patch.libraryRoot !== undefined) set('library_root', patch.libraryRoot?.trim() || null);
  if (patch.pathPrefix !== undefined) set('path_prefix', patch.pathPrefix?.trim() || null);
  if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);

  if (fields.length === 0) return existing;

  set('updated_at', Date.now());
  values.push(id);

  try {
    db.prepare(`UPDATE servers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) {
      throw new Error(`A server named "${patch.name}" already exists.`);
    }
    throw err;
  }
  return getServer(db, id)!;
}

export function deleteServer(db: Db, id: number): void {
  db.prepare('DELETE FROM servers WHERE id = ?').run(id);
}

/** Whether a stored key is sealed, for surfacing "unencrypted" warnings in the UI. */
export function serverKeyStatus(db: Db, id: number): { encrypted: boolean; masked: string } {
  const row = db.prepare('SELECT api_key FROM servers WHERE id = ?').get(id) as
    | { api_key: string }
    | undefined;
  if (!row) return { encrypted: false, masked: '' };
  const encrypted = isEncrypted(row.api_key);
  return {
    encrypted,
    masked: encrypted ? '••••••••' : maskSecret(decryptSecret(row.api_key)),
  };
}
