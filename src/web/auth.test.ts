import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../db/index.js';
import { Auth, SETUP_COOKIE } from './auth.js';
import type { RequestContext } from './router.js';

/**
 * Setting the first password. The code is the part that has to be typeable: it
 * is read off a screen or out of `.env` by a person.
 */

let dir: string;
let db: Db;
const ORIGINAL_CODE = process.env.BUTLER_SETUP_CODE;

/** A request carrying whatever cookies it was given, like the real one. */
function request(cookies: Record<string, string> = {}): RequestContext {
  return { cookies, params: {}, body: undefined } as unknown as RequestContext;
}

/** Claims setup the way the browser does, and returns a request holding it. */
function claimed(auth: Auth): RequestContext {
  const token = auth.claimSetup(request());
  return request({ [SETUP_COOKIE]: token });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'butler-auth-'));
  process.env.BUTLER_DATA_DIR = dir;
  db = openDb();
});

afterEach(() => {
  closeDb();
  delete process.env.BUTLER_DATA_DIR;
  if (ORIGINAL_CODE === undefined) delete process.env.BUTLER_SETUP_CODE;
  else process.env.BUTLER_SETUP_CODE = ORIGINAL_CODE;
  rmSync(dir, { recursive: true, force: true });
});

describe('Auth.completeSetup with BUTLER_SETUP_CODE', () => {
  // The code typed in has always been uppercased before the comparison, and the
  // one from the environment was not — so a lowercase code locked setup out of
  // its own instance, with the message insisting the value was wrong.
  it('accepts a lowercase code from the environment', () => {
    process.env.BUTLER_SETUP_CODE = 'verify-setup-123';
    const auth = new Auth(db, { exposed: true });
    expect(() => auth.completeSetup(claimed(auth), 'a-long-enough-password', 'verify-setup-123')).not.toThrow();
    expect(auth.configured).toBe(true);
  });

  it('ignores the case and surrounding space of what was typed', () => {
    process.env.BUTLER_SETUP_CODE = 'Mixed-Case';
    const auth = new Auth(db, { exposed: true });
    expect(() => auth.completeSetup(claimed(auth), 'a-long-enough-password', '  mIXED-case ')).not.toThrow();
  });

  it('still refuses a code that is simply wrong', () => {
    process.env.BUTLER_SETUP_CODE = 'ABCD-2345';
    const auth = new Auth(db, { exposed: true });
    expect(() => auth.completeSetup(claimed(auth), 'a-long-enough-password', 'ABCD-2346')).toThrow(
      /Incorrect setup code/,
    );
    expect(auth.configured).toBe(false);
  });
});
