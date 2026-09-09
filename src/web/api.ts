import { z } from 'zod';
import { AbsClient, resolveApiKey } from '../abs/client.js';
import { assessCapability, checkLocalRoot } from '../core/capability.js';
import { keyFilePath, keySource } from '../core/crypto.js';
import type { JobRunner } from '../core/jobs.js';
import { COMMANDS, FILE_COMMANDS, isRunCommand } from '../core/tasks.js';
import { AUDIT_CODES } from '../core/audit.js';
import { FILLABLE } from '../core/metadata.js';
import { NORMALIZABLE } from '../core/normalize.js';
import { DEFAULT_TEMPLATE, unavailableMessage } from '../core/organize.js';
import { PROVIDER_NAMES } from '../providers/index.js';
import { AGE_BANDS, CONTENT_FLAGS } from '../content/ageRating.js';
import type { Db } from '../db/index.js';
import { listLogs } from '../db/logs.js';
import { getRun, listRuns, type RunCommand, type RunStatus } from '../db/runs.js';
import { countRevisions } from '../db/revisions.js';
import { openContext } from '../context.js';
import { checkForUpdate } from '../core/updates.js';
import { VERSION } from '../version.js';
import { runRevertTask } from '../core/revert.js';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  updateSchedule,
} from '../db/schedules.js';
import {
  connectionKeyStatus,
  deleteConnection,
  getConnection,
  getConnectionWithKey,
  rotateEncryptionKey,
  saveConnection,
  updateConnection,
} from '../db/connection.js';
import { getSettings, updateSettings, SettingsSchema } from '../db/settings.js';
import type { Auth } from './auth.js';
import {
  clearSessionCookie,
  clearSetupCookie,
  setSessionCookie,
  setSetupCookie,
  SESSION_COOKIE,
} from './auth.js';
import { badRequest, notFound, Router, type RequestContext } from './router.js';

/**
 * The two ways to prove who you are.
 *
 * An API token is the preferred form and the only one stored. A username and
 * password are accepted as a convenience — they are exchanged for a token on
 * the spot and then discarded, so the credential at rest is identical either
 * way. Blank means "keep the existing token": the UI never receives the real
 * one to send back, so an empty field must not wipe it.
 */
const credentialFields = {
  apiKey: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
};

const ConnectionBaseSchema = z.object({
  url: z.string().url('Must be a full URL, e.g. http://localhost:13378'),
  libraryRoot: z.string().nullish(),
  pathPrefix: z.string().nullish(),
  ...credentialFields,
});

/** A username without its password is a half-filled form, not a credential. */
const bothOrNeither = (v: { username?: string; password?: string }) =>
  Boolean(v.username) === Boolean(v.password);

const ConnectionInputSchema = ConnectionBaseSchema.refine(
  (v) => Boolean(v.apiKey) || (Boolean(v.username) && Boolean(v.password)),
  { message: 'Provide either an API token, or a username and password.', path: ['apiKey'] },
).refine(bothOrNeither, {
  message: 'A username and a password are both required.',
  path: ['password'],
});

const ConnectionPatchSchema = ConnectionBaseSchema.partial().refine(bothOrNeither, {
  message: 'A username and a password are both required.',
  path: ['password'],
});

const RunInputSchema = z.object({
  command: z.string().refine(isRunCommand, { message: `Must be one of ${COMMANDS.join(', ')}` }),
  options: z.record(z.unknown()).default({}),
});

const ScheduleInputSchema = z.object({
  command: z.string().refine(isRunCommand, { message: `Must be one of ${COMMANDS.join(', ')}` }),
  options: z.record(z.unknown()).default({}),
  intervalMinutes: z.number().int().min(5).max(60 * 24 * 30),
  enabled: z.boolean().optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return result.data;
}

/** Public shape of the connection: never includes the API key, encrypted or not. */
function publicConnection(db: Db) {
  const connection = getConnection(db);
  if (!connection) return null;
  // `files` comes from a local stat, not a call to AudiobookShelf, so this stays
  // cheap while still letting the UI disable organize up front.
  return { ...connection, key: connectionKeyStatus(db), files: checkLocalRoot(connection) };
}

function requireConnection(db: Db) {
  const connection = getConnection(db);
  if (!connection) throw badRequest('AudiobookShelf is not connected yet.');
  return connection;
}

/**
 * Refuses a run the settings or the filesystem would refuse anyway.
 *
 * Checked at this point so the caller gets an immediate, explained rejection
 * instead of a queued run that only fails once it reaches the front — and so a
 * schedule cannot be created for work that could never execute.
 *
 * The two guards differ in shape on purpose: a file command is unavailable
 * outright when the media is out of reach, since even planning a move needs
 * paths this machine can see. A normalize can always be planned, and only
 * *applying* it is gated.
 */
function assertCommandAllowed(
  db: Db,
  command: RunCommand,
  options: Record<string, unknown> = {},
): void {
  if (FILE_COMMANDS.has(command)) {
    const local = checkLocalRoot(requireConnection(db));
    if (!local.canManageFiles) throw badRequest(unavailableMessage(local.reason));
  }

  // Not refused outright any more: with the switch off a normalize still
  // applies the additive half of its plan — a work identity on a book that had
  // none — and holds back only the replacements. The run reports what it held.

}

const RevertInputSchema = z.object({
  apply: z.boolean().optional(),
  force: z.boolean().optional(),
});

export interface ApiDeps {
  db: Db;
  runner: JobRunner;
  auth: Auth;
  isSecure: (ctx: RequestContext) => boolean;
}

export function buildApiRouter(deps: ApiDeps): Router {
  const { db, runner, auth } = deps;
  const router = new Router();

  // ---- auth ----
  router.get('/api/auth/status', (ctx) => ({
    configured: auth.configured,
    authenticated: auth.isAuthenticated(ctx),
    setup: auth.setupState(ctx),
  }), { isPublic: true });

  router.post('/api/auth/setup/claim', (ctx) => {
    const token = auth.claimSetup(ctx);
    setSetupCookie(ctx.res, token, deps.isSecure(ctx));
    return { ok: true };
  }, { isPublic: true });

  router.post('/api/auth/setup', (ctx) => {
    const { password, code } = parse(
      z.object({ password: z.string().min(1), code: z.string().optional() }),
      ctx.body,
    );
    const sessionId = auth.completeSetup(ctx, password, code);
    setSessionCookie(ctx.res, sessionId, deps.isSecure(ctx));
    clearSetupCookie(ctx.res);
    return { ok: true };
  }, { isPublic: true });

  router.post('/api/auth/login', (ctx) => {
    const { password } = parse(z.object({ password: z.string().min(1) }), ctx.body);
    const sessionId = auth.login(password, ctx);
    setSessionCookie(ctx.res, sessionId, deps.isSecure(ctx));
    return { ok: true };
  }, { isPublic: true });

  router.post('/api/auth/logout', (ctx) => {
    auth.logout(ctx.cookies[SESSION_COOKIE]);
    clearSessionCookie(ctx.res);
    return { ok: true };
  }, { isPublic: true });

  router.post('/api/auth/password', (ctx) => {
    const { current, next } = parse(
      z.object({ current: z.string().min(1), next: z.string().min(1) }),
      ctx.body,
    );
    auth.changePassword(current, next, ctx.cookies[SESSION_COOKIE]);
    return { ok: true };
  });

  // ---- connection ----
  router.get('/api/connection', () => ({ connection: publicConnection(db) }));

  router.put('/api/connection', async (ctx) => {
    const input = parse(ConnectionInputSchema, ctx.body);
    // Credentials become a token before anything else happens, so what gets
    // verified is exactly what gets stored.
    const apiKey = await resolveApiKey(input.url, input);
    // Verify before saving, so a typo surfaces here rather than on first run.
    await new AbsClient({ baseUrl: input.url, token: apiKey }).listLibraries();
    // Destructured rather than spread so it is visible that the password does
    // not reach the database.
    const { username: _username, password: _password, ...rest } = input;
    saveConnection(db, { ...rest, apiKey });
    return { connection: publicConnection(db) };
  });

  router.patch('/api/connection', async (ctx) => {
    const patch = parse(ConnectionPatchSchema, ctx.body);
    const current = getConnectionWithKey(db);
    if (!current) throw badRequest('AudiobookShelf is not connected yet.');

    const url = patch.url ?? current.url;
    const reauthenticating = Boolean(patch.apiKey) || Boolean(patch.username && patch.password);
    const apiKey = reauthenticating ? await resolveApiKey(url, patch) : current.apiKey;

    if (patch.url || reauthenticating) {
      await new AbsClient({ baseUrl: url, token: apiKey }).listLibraries();
    }
    const { username: _username, password: _password, ...rest } = patch;
    updateConnection(db, { ...rest, ...(reauthenticating ? { apiKey } : {}) });
    return { connection: publicConnection(db) };
  });

  router.delete('/api/connection', () => {
    deleteConnection(db);
    return { ok: true };
  });

  /** Connectivity plus the filesystem capability report. */
  router.get('/api/connection/capability', async () => {
    const connection = requireConnection(db);
    const withKey = getConnectionWithKey(db)!;

    const client = new AbsClient({ baseUrl: withKey.url, token: withKey.apiKey });
    try {
      const libraries = await client.listLibraries();
      return {
        reachable: true,
        libraries: libraries.map((l) => ({
          id: l.id,
          name: l.name,
          mediaType: l.mediaType,
          folders: l.folders.map((f) => f.fullPath),
        })),
        capability: assessCapability(connection, libraries),
      };
    } catch (err) {
      return { reachable: false, error: (err as Error).message, libraries: [], capability: null };
    }
  });

  // ---- runs ----
  router.get('/api/runs', (ctx) => {
    const command = ctx.url.searchParams.get('command');
    const status = ctx.url.searchParams.get('status');

    return {
      ...listRuns(db, {
        ...(command && isRunCommand(command) ? { command: command as RunCommand } : {}),
        ...(status ? { status: status as RunStatus } : {}),
        limit: Number(ctx.url.searchParams.get('limit') ?? 50),
        offset: Number(ctx.url.searchParams.get('offset') ?? 0),
      }),
      activeRunId: runner.activeRunId,
      queued: runner.queuedRunIds,
    };
  });

  router.get('/api/runs/:id', (ctx) => {
    const run = getRun(db, numericParam(ctx, 'id'));
    if (!run) throw notFound('No such run');
    // The undo count travels with the run, so the page can offer a revert
    // without a second request and without guessing whether one is possible.
    return { ...run, revisions: countRevisions(db, run.id) };
  });

  /**
   * Puts a run back. A dry run by default, like everything else that writes —
   * the response lists what it would restore and what it would skip.
   */
  router.post('/api/runs/:id/revert', async (ctx) => {
    const input = parse(RevertInputSchema, ctx.body ?? {});
    const runId = numericParam(ctx, 'id');
    if (!getRun(db, runId)) throw notFound('No such run');
    return runRevertTask({ ...openContext(db), runId }, { runId, ...input });
  });

  router.post('/api/runs', (ctx) => {
    const input = parse(RunInputSchema, ctx.body);
    requireConnection(db);
    assertCommandAllowed(db, input.command as RunCommand, input.options);
    return runner.enqueue({
      command: input.command as RunCommand,
      options: input.options,
      trigger: 'manual',
    });
  });

  router.post('/api/runs/:id/cancel', (ctx) => {
    const id = numericParam(ctx, 'id');
    const cancelled = runner.cancel(id);
    if (!cancelled) {
      throw badRequest(
        runner.activeRunId === id
          ? 'This run is already executing and cannot be cancelled mid-flight.'
          : 'This run is not queued.',
      );
    }
    return { ok: true };
  });

  // ---- logs ----
  router.get('/api/logs', (ctx) => {
    const runIdParam = ctx.url.searchParams.get('runId');
    const afterId = ctx.url.searchParams.get('afterId');
    const logs = listLogs(db, {
      ...(runIdParam ? { runId: Number(runIdParam) } : {}),
      ...(afterId ? { afterId: Number(afterId) } : {}),
      ...(ctx.url.searchParams.get('level') ? { level: ctx.url.searchParams.get('level')! } : {}),
      ...(ctx.url.searchParams.get('search') ? { search: ctx.url.searchParams.get('search')! } : {}),
      limit: Number(ctx.url.searchParams.get('limit') ?? 500),
    });
    return { logs, lastId: logs.at(-1)?.id ?? Number(afterId ?? 0) };
  });

  // ---- schedules ----
  router.get('/api/schedules', () => listSchedules(db));

  router.post('/api/schedules', (ctx) => {
    const input = parse(ScheduleInputSchema, ctx.body);
    requireConnection(db);
    assertCommandAllowed(db, input.command as RunCommand, input.options);
    return createSchedule(db, { ...input, command: input.command as RunCommand });
  });

  router.patch('/api/schedules/:id', (ctx) => {
    const { command, ...rest } = parse(ScheduleInputSchema.partial(), ctx.body);
    return updateSchedule(db, numericParam(ctx, 'id'), {
      ...rest,
      ...(command ? { command: command as RunCommand } : {}),
    });
  });

  router.delete('/api/schedules/:id', (ctx) => {
    deleteSchedule(db, numericParam(ctx, 'id'));
    return { ok: true };
  });

  // ---- settings ----
  router.get('/api/settings', () => ({
    settings: redactSettings(getSettings(db)),
    security: securityStatus(db),
  }));

  router.patch('/api/settings', (ctx) => {
    const patch = parse(SettingsSchema.partial(), ctx.body);
    return { settings: redactSettings(updateSettings(db, patch)) };
  });

  router.post('/api/settings/rotate-key', () => {
    rotateEncryptionKey(db);
    return { ok: true, security: securityStatus(db) };
  });

  /** Everything the UI needs to render forms without hardcoding server-side vocabulary. */
  router.get('/api/meta', () => ({
    commands: COMMANDS,
    fileCommands: [...FILE_COMMANDS],
    auditCodes: AUDIT_CODES,
    metadataFields: [...FILLABLE],
    normalizeFields: [...NORMALIZABLE],
    providers: [...PROVIDER_NAMES],
    ageBands: [...AGE_BANDS],
    contentFlags: [...CONTENT_FLAGS],
    defaultTemplate: DEFAULT_TEMPLATE,
  }));

  router.get('/api/health', () => ({ ok: true, version: VERSION }), { isPublic: true });

  /**
   * Whether a newer version exists. Answers with the check switched off rather
   * than 404ing, so the UI has one shape to render either way.
   */
  router.get('/api/update', async () => {
    if (!getSettings(db).checkForUpdates) {
      return { current: VERSION, latest: null, available: false, checkedAt: null, disabled: true };
    }
    return { ...(await checkForUpdate(VERSION)), disabled: false };
  });

  return router;
}

function securityStatus(db: Db) {
  return {
    keySource: keySource(),
    keyPath: keySource() === 'file' ? keyFilePath() : null,
    apiKeyEncrypted: connectionKeyStatus(db).encrypted,
  };
}

function numericParam(ctx: RequestContext, name: string): number {
  const raw = ctx.params[name];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw badRequest(`Invalid ${name}`);
  return value;
}

/** The Google Books key is a credential; the UI shows only whether one is set. */
function redactSettings(settings: ReturnType<typeof getSettings>) {
  const { googleBooksApiKey, ...rest } = settings;
  return { ...rest, googleBooksApiKeySet: googleBooksApiKey.length > 0 };
}
