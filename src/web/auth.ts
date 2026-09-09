import { randomInt, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Db } from '../db/index.js';
import { createSession, destroyAllSessions, destroySession, isSessionValid } from '../db/sessions.js';
import { hashPassword, keyFilePath, keySource, randomToken, verifyPassword } from '../core/crypto.js';
import { getMeta, setMeta } from '../db/settings.js';
import { setupCode } from '../config.js';
import { log } from '../logger.js';
import { badRequest, tooManyRequests, unauthorized, type RequestContext } from './router.js';
import { clientKey, Throttle } from './throttle.js';

export const SESSION_COOKIE = 'abs_butler_session';
export const SETUP_COOKIE = 'abs_butler_setup';

/**
 * How long after startup an un-configured instance will accept a password.
 *
 * Setup has to be reachable by someone who has not authenticated yet — there is
 * nothing to authenticate against. Rather than leaving that open forever, it is
 * bounded: you install, you open the UI, you set a password. After the window
 * closes, restarting reopens it, so the recovery path needs no stored state.
 */
export const SETUP_WINDOW_MS = 15 * 60_000;

/**
 * A claim is released after this long so an abandoned setup page — a browser
 * closed, a phone that went to sleep — cannot lock the real operator out until
 * they restart.
 */
const CLAIM_TTL_MS = 10 * 60_000;

/** No I/O/0/1: these get read off a screen and typed by hand. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  const pick = () =>
    Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface AuthConfig {
  /** True when the server is reachable beyond localhost. */
  exposed: boolean;
}

export interface SetupState {
  required: boolean;
  open: boolean;
  /** Null once setup is done, or once the window has closed. */
  expiresAt: number | null;
  codeRequired: boolean;
  claimed: boolean;
  /** True when this request holds the claim. */
  mine: boolean;
}

export class Auth {
  private readonly startedAt = Date.now();
  private readonly code = setupCode() ?? generateCode();
  private readonly codeFromEnv = Boolean(setupCode());
  private claim: { token: string; at: number } | null = null;
  private readonly throttle = new Throttle();

  /** Refuses early, so a blocked caller never reaches the hash comparison. */
  private guard(ctx: RequestContext | undefined): string {
    const key = clientKey(ctx?.req?.socket?.remoteAddress);
    const waitMs = this.throttle.retryAfterMs(key);
    if (waitMs > 0) {
      throw tooManyRequests(
        `Too many failed attempts. Try again in ${Math.ceil(waitMs / 1000)}s.`,
      );
    }
    return key;
  }

  constructor(
    private readonly db: Db,
    private readonly config: AuthConfig,
  ) {}

  private get hash(): string | null {
    return getMeta(this.db, 'password_hash');
  }

  /** Whether a password has been set. Until it is, nothing but setup is reachable. */
  get configured(): boolean {
    return Boolean(this.hash);
  }

  /** Kept for callers asking "is this instance protected". */
  get enabled(): boolean {
    return this.configured;
  }

  private get windowOpen(): boolean {
    return Date.now() - this.startedAt < SETUP_WINDOW_MS;
  }

  private claimHeldBySomeoneElse(ctx: RequestContext): boolean {
    if (!this.claim) return false;
    if (Date.now() - this.claim.at > CLAIM_TTL_MS) return false;
    return ctx.cookies[SETUP_COOKIE] !== this.claim.token;
  }

  setupState(ctx: RequestContext): SetupState {
    const required = !this.configured;
    const live = this.claim !== null && Date.now() - this.claim.at <= CLAIM_TTL_MS;
    return {
      required,
      open: required && (this.windowOpen || this.codeFromEnv),
      expiresAt: required && this.windowOpen ? this.startedAt + SETUP_WINDOW_MS : null,
      codeRequired: required && (this.codeFromEnv || !this.windowOpen),
      claimed: live,
      mine: live && ctx.cookies[SETUP_COOKIE] === this.claim!.token,
    };
  }

  /**
   * Hands the setup flow to whoever asks first.
   *
   * Once a browser holds the claim, nobody else can submit a password — so the
   * race is only winnable before you have opened the page, not after.
   */
  claimSetup(ctx: RequestContext): string {
    if (this.configured) throw badRequest('abs-butler is already set up.');
    if (this.claimHeldBySomeoneElse(ctx)) {
      throw badRequest(
        'Setup is already in progress in another browser. If that was not you, restart ' +
          'abs-butler to invalidate it.',
      );
    }
    const existing = ctx.cookies[SETUP_COOKIE];
    if (this.claim && existing === this.claim.token) {
      this.claim = { token: existing, at: Date.now() };
      return existing;
    }
    const token = randomToken(24);
    this.claim = { token, at: Date.now() };
    return token;
  }

  completeSetup(ctx: RequestContext, password: string, code?: string): string {
    if (this.configured) throw badRequest('abs-butler is already set up.');

    const state = this.setupState(ctx);
    if (!state.mine) {
      throw badRequest('Start setup in this browser before setting a password.');
    }
    if (state.codeRequired) {
      const key = this.guard(ctx);
      if (!code || !constantTimeEquals(code.trim().toUpperCase(), this.code)) {
        this.throttle.recordFailure(key);
        throw unauthorized(
          this.codeFromEnv
            ? 'Incorrect setup code. It is the value of BUTLER_SETUP_CODE.'
            : 'The setup window has closed. Restart abs-butler to reopen it, or enter the setup ' +
              'code printed in its startup log.',
        );
      }
    }
    assertPasswordAcceptable(password);

    setMeta(this.db, 'password_hash', hashPassword(password));
    this.claim = null;
    log.success('password set — abs-butler is now protected');
    return createSession(this.db);
  }

  login(password: string, ctx?: RequestContext): string {
    const key = this.guard(ctx);
    const hash = this.hash;
    if (!hash) throw badRequest('abs-butler has not been set up yet.');
    if (!verifyPassword(password, hash)) {
      this.throttle.recordFailure(key);
      throw unauthorized('Incorrect password');
    }
    this.throttle.clear(key);
    return createSession(this.db);
  }

  /**
   * Changing the password drops every other session: the usual reason to change
   * it is that you think someone else may have one.
   */
  changePassword(current: string, next: string, keepSessionId?: string): void {
    const hash = this.hash;
    if (!hash) throw badRequest('abs-butler has not been set up yet.');
    if (!verifyPassword(current, hash)) throw unauthorized('Current password is incorrect');
    assertPasswordAcceptable(next);

    setMeta(this.db, 'password_hash', hashPassword(next));
    destroyAllSessions(this.db, keepSessionId);
  }

  logout(sessionId: string | undefined): void {
    if (sessionId) destroySession(this.db, sessionId);
  }

  isAuthenticated(ctx: RequestContext): boolean {
    if (!this.configured) return false;
    const sessionId = ctx.cookies[SESSION_COOKIE];
    return Boolean(sessionId && isSessionValid(this.db, sessionId));
  }

  requireAuth(ctx: RequestContext): void {
    if (!this.configured) {
      throw unauthorized('abs-butler has not been set up yet. Open the web UI to set a password.');
    }
    if (!this.isAuthenticated(ctx)) throw unauthorized();
  }

  /** Startup reporting, so an unprotected or unusual setup is never silent. */
  announce(): void {
    log.debug(`encryption key source: ${keySource() === 'env' ? 'BUTLER_SECRET' : keyFilePath()}`);

    if (this.configured) return;

    if (this.codeFromEnv) {
      log.warn('Not set up yet. Setup requires the code in BUTLER_SETUP_CODE.');
      return;
    }
    log.warn(
      `Not set up yet — open the web UI within ${SETUP_WINDOW_MS / 60_000} minutes to set a password.` +
        (this.config.exposed ? ' This port is reachable beyond localhost.' : ''),
    );
    log.info(`setup code (only needed if that window closes): ${this.code}`);
  }
}

function assertPasswordAcceptable(password: string): void {
  if (password.length < 8) throw badRequest('Password must be at least 8 characters.');
  if (password.length > 200) throw badRequest('Password must be at most 200 characters.');
}

export function setSessionCookie(res: ServerResponse, sessionId: string, secure: boolean): void {
  setCookie(res, SESSION_COOKIE, sessionId, secure, 7 * 24 * 60 * 60);
}

export function setSetupCookie(res: ServerResponse, token: string, secure: boolean): void {
  setCookie(res, SETUP_COOKIE, token, secure, CLAIM_TTL_MS / 1000);
}

function setCookie(
  res: ServerResponse,
  name: string,
  value: string,
  secure: boolean,
  maxAge: number,
): void {
  const attributes = [`${name}=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAge}`];
  // Only set Secure when actually served over TLS — otherwise the cookie is
  // silently dropped on a plain-HTTP LAN install and login appears to do nothing.
  if (secure) attributes.push('Secure');
  appendCookie(res, attributes.join('; '));
}

export function clearSessionCookie(res: ServerResponse): void {
  appendCookie(res, `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** Appends rather than replaces: completing setup sets a session and clears the claim. */
function appendCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  const all = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('Set-Cookie', [...all, cookie]);
}

export function clearSetupCookie(res: ServerResponse): void {
  appendCookie(res, `${SETUP_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
