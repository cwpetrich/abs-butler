import type { Db } from './index.js';
import { randomToken } from '../core/crypto.js';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createSession(db: Db, ttlMs = DEFAULT_TTL_MS): string {
  const id = randomToken(32);
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)').run(
    id,
    now,
    now + ttlMs,
  );
  return id;
}

export function isSessionValid(db: Db, id: string): boolean {
  if (!id) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(id) as
    | { expires_at: number }
    | undefined;
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    destroySession(db, id);
    return false;
  }
  return true;
}

export function destroySession(db: Db, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/** Invalidates every login — used when the password changes. */
export function destroyAllSessions(db: Db): void {
  db.exec('DELETE FROM sessions');
}

export function pruneSessions(db: Db): number {
  const result = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return Number(result.changes);
}
