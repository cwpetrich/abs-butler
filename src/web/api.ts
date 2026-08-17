import { z } from 'zod';
import { AbsClient } from '../abs/client.js';
import { assessCapability, checkLocalRoot } from '../core/capability.js';
import { hasSecret } from '../core/crypto.js';
import type { JobRunner } from '../core/jobs.js';
import { COMMANDS, FILE_COMMANDS, isRunCommand } from '../core/tasks.js';
import { AUDIT_CODES } from '../core/audit.js';
import { FILLABLE } from '../core/metadata.js';
import { DEFAULT_TEMPLATE, unavailableMessage } from '../core/organize.js';
import { PROVIDER_NAMES } from '../providers/index.js';
import { AGE_BANDS, CONTENT_FLAGS } from '../content/ageRating.js';
import type { Db } from '../db/index.js';
import { listLogs } from '../db/logs.js';
import { getRun, listRuns, type RunCommand, type RunStatus } from '../db/runs.js';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  updateSchedule,
} from '../db/schedules.js';
import {
  createServer,
  deleteServer,
  getServer,
  getServerWithKey,
  listServers,
  serverKeyStatus,
  updateServer,
} from '../db/servers.js';
import { getSettings, updateSettings, SettingsSchema } from '../db/settings.js';
import type { Auth } from './auth.js';
import { clearSessionCookie, setSessionCookie, SESSION_COOKIE } from './auth.js';
import { badRequest, notFound, Router, type RequestContext } from './router.js';

const ServerInputSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  url: z.string().url('Must be a full URL, e.g. http://localhost:13378'),
  apiKey: z.string().min(1, 'API key is required'),
  libraryRoot: z.string().nullish(),
  pathPrefix: z.string().nullish(),
  enabled: z.boolean().optional(),
});

const ServerPatchSchema = ServerInputSchema.partial().extend({
  // Blank means "keep the existing key" — the UI never receives the real one
  // to send back, so an empty field must not wipe it.
  apiKey: z.string().optional(),
});

const RunInputSchema = z.object({
  serverId: z.number().int().positive(),
  command: z.string().refine(isRunCommand, { message: `Must be one of ${COMMANDS.join(', ')}` }),
  options: z.record(z.unknown()).default({}),
});

const ScheduleInputSchema = z.object({
  serverId: z.number().int().positive(),
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

/** Public shape of a server: never includes the API key, encrypted or not. */
function publicServer(db: Db, id: number) {
  const server = getServer(db, id);
  if (!server) throw notFound(`No server with id ${id}`);
  // `files` comes from a local stat, not a call to AudiobookShelf, so listing
  // servers stays cheap while still letting the UI disable organize up front.
  return { ...server, key: serverKeyStatus(db, id), files: checkLocalRoot(server) };
}

/**
 * Refuses a file-touching command for a server whose media this machine cannot
 * reach. Checked here so the caller gets an immediate, explained rejection
 * instead of a queued run that only fails once it reaches the front.
 */
function assertFileCommandAllowed(db: Db, serverId: number, command: RunCommand): void {
  if (!FILE_COMMANDS.has(command)) return;
  const server = getServer(db, serverId);
  if (!server) throw notFound(`No server with id ${serverId}`);

  const local = checkLocalRoot(server);
  if (!local.canManageFiles) throw badRequest(unavailableMessage(server.name, local.reason));
}

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
    authRequired: auth.enabled,
    authenticated: auth.isAuthenticated(ctx),
    encryptionEnabled: hasSecret(),
  }), { isPublic: true });

  router.post('/api/auth/login', (ctx) => {
    const { password } = parse(z.object({ password: z.string().min(1) }), ctx.body);
    const sessionId = auth.login(password);
    setSessionCookie(ctx.res, sessionId, deps.isSecure(ctx));
    return { ok: true };
  }, { isPublic: true });

  router.post('/api/auth/logout', (ctx) => {
    auth.logout(ctx.cookies[SESSION_COOKIE]);
    clearSessionCookie(ctx.res);
    return { ok: true };
  }, { isPublic: true });

  // ---- servers ----
  router.get('/api/servers', () => listServers(db).map((s) => publicServer(db, s.id)));

  router.post('/api/servers', async (ctx) => {
    const input = parse(ServerInputSchema, ctx.body);
    // Verify before saving, so a typo surfaces here rather than on first run.
    const client = new AbsClient({ baseUrl: input.url, token: input.apiKey });
    await client.listLibraries();
    const created = createServer(db, input);
    return publicServer(db, created.id);
  });

  router.patch('/api/servers/:id', async (ctx) => {
    const id = numericParam(ctx, 'id');
    const patch = parse(ServerPatchSchema, ctx.body);

    if (patch.url || patch.apiKey) {
      const current = getServerWithKey(db, id);
      if (!current) throw notFound(`No server with id ${id}`);
      const client = new AbsClient({
        baseUrl: patch.url ?? current.url,
        token: patch.apiKey || current.apiKey,
      });
      await client.listLibraries();
    }
    updateServer(db, id, patch);
    return publicServer(db, id);
  });

  router.delete('/api/servers/:id', (ctx) => {
    const id = numericParam(ctx, 'id');
    if (!getServer(db, id)) throw notFound(`No server with id ${id}`);
    deleteServer(db, id);
    return { ok: true };
  });

  /** Connectivity plus the filesystem capability report for this server. */
  router.get('/api/servers/:id/capability', async (ctx) => {
    const id = numericParam(ctx, 'id');
    const server = getServer(db, id);
    const withKey = getServerWithKey(db, id);
    if (!server || !withKey) throw notFound(`No server with id ${id}`);

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
        capability: assessCapability(server, libraries),
      };
    } catch (err) {
      return { reachable: false, error: (err as Error).message, libraries: [], capability: null };
    }
  });

  // ---- runs ----
  router.get('/api/runs', (ctx) => {
    const serverId = ctx.url.searchParams.get('serverId');
    const command = ctx.url.searchParams.get('command');
    const status = ctx.url.searchParams.get('status');

    return {
      ...listRuns(db, {
        ...(serverId ? { serverId: Number(serverId) } : {}),
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
    return run;
  });

  router.post('/api/runs', (ctx) => {
    const input = parse(RunInputSchema, ctx.body);
    if (!getServer(db, input.serverId)) throw notFound(`No server with id ${input.serverId}`);
    assertFileCommandAllowed(db, input.serverId, input.command as RunCommand);
    return runner.enqueue({
      serverId: input.serverId,
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
    if (!getServer(db, input.serverId)) throw notFound(`No server with id ${input.serverId}`);
    assertFileCommandAllowed(db, input.serverId, input.command as RunCommand);
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
    encryptionEnabled: hasSecret(),
    authRequired: auth.enabled,
  }));

  router.patch('/api/settings', (ctx) => {
    const patch = parse(SettingsSchema.partial(), ctx.body);
    return { settings: redactSettings(updateSettings(db, patch)) };
  });

  /** Everything the UI needs to render forms without hardcoding server-side vocabulary. */
  router.get('/api/meta', () => ({
    commands: COMMANDS,
    fileCommands: [...FILE_COMMANDS],
    auditCodes: AUDIT_CODES,
    metadataFields: [...FILLABLE],
    providers: [...PROVIDER_NAMES],
    ageBands: [...AGE_BANDS],
    contentFlags: [...CONTENT_FLAGS],
    defaultTemplate: DEFAULT_TEMPLATE,
  }));

  router.get('/api/health', () => ({ ok: true, version: '0.2.0' }), { isPublic: true });

  return router;
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
