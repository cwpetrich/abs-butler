import type { ServerResponse } from 'node:http';
import type { Db } from '../db/index.js';
import { createSession, destroySession, isSessionValid } from '../db/sessions.js';
import { hasSecret, verifyPassword, hashPassword } from '../core/crypto.js';
import { getMeta, setMeta } from '../db/settings.js';
import { log } from '../logger.js';
import { unauthorized, type RequestContext } from './router.js';

export const SESSION_COOKIE = 'abs_butler_session';

export interface AuthConfig {
  /** Plaintext password from BUTLER_PASSWORD, if configured. */
  password?: string | undefined;
  /** True when the server is reachable beyond localhost. */
  exposed: boolean;
}

export class Auth {
  private readonly hash: string | undefined;

  constructor(
    private readonly db: Db,
    private readonly config: AuthConfig,
  ) {
    if (config.password) {
      // Hashed once at startup and kept in memory; the plaintext never reaches
      // the database, and a stored hash lets sessions survive a restart.
      const existing = getMeta(db, 'password_hash');
      if (existing && verifyPassword(config.password, existing)) {
        this.hash = existing;
      } else {
        this.hash = hashPassword(config.password);
        setMeta(db, 'password_hash', this.hash);
      }
    }
  }

  get enabled(): boolean {
    return Boolean(this.hash);
  }

  /** Startup warnings for insecure configurations, so they are never silent. */
  warnIfInsecure(): void {
    if (!this.enabled) {
      log.warn(
        this.config.exposed
          ? 'No BUTLER_PASSWORD set and the web UI is listening on all interfaces — anyone who can reach this port can read your AudiobookShelf API keys.'
          : 'No BUTLER_PASSWORD set. The web UI is unauthenticated.',
      );
    }
    if (!hasSecret()) {
      log.warn('No BUTLER_SECRET set — API keys are stored unencrypted in the database.');
    }
  }

  login(password: string): string {
    if (!this.hash) throw unauthorized('Authentication is not configured');
    if (!verifyPassword(password, this.hash)) throw unauthorized('Incorrect password');
    return createSession(this.db);
  }

  logout(sessionId: string | undefined): void {
    if (sessionId) destroySession(this.db, sessionId);
  }

  isAuthenticated(ctx: RequestContext): boolean {
    if (!this.enabled) return true;
    const sessionId = ctx.cookies[SESSION_COOKIE];
    return Boolean(sessionId && isSessionValid(this.db, sessionId));
  }

  requireAuth(ctx: RequestContext): void {
    if (!this.isAuthenticated(ctx)) throw unauthorized();
  }
}

export function setSessionCookie(res: ServerResponse, sessionId: string, secure: boolean): void {
  const attributes = [
    `${SESSION_COOKIE}=${sessionId}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];
  // Only set Secure when actually served over TLS — otherwise the cookie is
  // silently dropped on a plain-HTTP LAN install and login appears to do nothing.
  if (secure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
