/** Typed client for the abs-butler API. All calls are same-origin. */

export type FileAccess = 'read-write' | 'read-only' | 'unreachable' | 'not-configured';

export interface LocalRootStatus {
  /** False means file organization is unavailable, full stop. */
  canManageFiles: boolean;
  access: FileAccess;
  reason: string;
  path: string | null;
}

export interface Connection {
  url: string;
  libraryRoot: string | null;
  pathPrefix: string | null;
  createdAt: number;
  updatedAt: number;
  key: { encrypted: boolean };
  files: LocalRootStatus;
}

export interface SetupState {
  required: boolean;
  open: boolean;
  expiresAt: number | null;
  codeRequired: boolean;
  claimed: boolean;
  mine: boolean;
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  setup: SetupState;
}

export interface SecurityStatus {
  keySource: 'env' | 'file';
  keyPath: string | null;
  apiKeyEncrypted: boolean;
}

export type RunCommand = 'audit' | 'rate' | 'metadata' | 'organize';
export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

export interface Run {
  id: number;
  command: RunCommand;
  options: Record<string, unknown>;
  status: RunStatus;
  dryRun: boolean;
  trigger: 'manual' | 'schedule' | 'cli';
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  summary: Record<string, unknown> | null;
  error: string | null;
}

export interface LogEntry {
  id: number;
  runId: number | null;
  ts: number;
  level: string;
  message: string;
}

export interface Schedule {
  id: number;
  command: RunCommand;
  options: Record<string, unknown>;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
}

export interface LibraryCapability {
  libraryId: string;
  libraryName: string;
  absPath: string;
  localPath: string | null;
  access: FileAccess;
  reason?: string;
}

export interface CapabilityReport {
  reachable: boolean;
  error?: string;
  libraries: Array<{ id: string; name: string; mediaType: string; folders: string[] }>;
  capability: {
    canManageFiles: boolean;
    reason: string;
    libraries: LibraryCapability[];
  } | null;
}

export interface Settings {
  providers: string[];
  providerConcurrency: number;
  minConfidence: number;
  historyLimit: number;
  logRetentionDays: number;
  allowFileChanges: boolean;
  googleBooksApiKeySet: boolean;
}

export interface Meta {
  commands: RunCommand[];
  fileCommands: RunCommand[];
  auditCodes: string[];
  metadataFields: string[];
  providers: string[];
  ageBands: string[];
  contentFlags: string[];
  defaultTemplate: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  const text = await res.text();
  const payload = text ? (JSON.parse(text) as unknown) : undefined;

  if (!res.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed with ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return payload as T;
}

const body = (value: unknown) => JSON.stringify(value);

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  claimSetup: () => request<{ ok: true }>('/api/auth/setup/claim', { method: 'POST' }),
  completeSetup: (password: string, code?: string) =>
    request<{ ok: true }>('/api/auth/setup', { method: 'POST', body: body({ password, code }) }),
  login: (password: string) =>
    request<{ ok: true }>('/api/auth/login', { method: 'POST', body: body({ password }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  changePassword: (current: string, next: string) =>
    request<{ ok: true }>('/api/auth/password', { method: 'POST', body: body({ current, next }) }),

  meta: () => request<Meta>('/api/meta'),

  connection: () => request<{ connection: Connection | null }>('/api/connection'),
  saveConnection: (input: Record<string, unknown>) =>
    request<{ connection: Connection }>('/api/connection', { method: 'PUT', body: body(input) }),
  updateConnection: (patch: Record<string, unknown>) =>
    request<{ connection: Connection }>('/api/connection', { method: 'PATCH', body: body(patch) }),
  disconnect: () => request<{ ok: true }>('/api/connection', { method: 'DELETE' }),
  capability: () => request<CapabilityReport>('/api/connection/capability'),

  runs: (params: Record<string, string | number | undefined> = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return request<{ runs: Run[]; total: number; activeRunId: number | null; queued: number[] }>(
      `/api/runs?${query}`,
    );
  },
  run: (id: number) => request<Run>(`/api/runs/${id}`),
  startRun: (input: { command: RunCommand; options: Record<string, unknown> }) =>
    request<Run>('/api/runs', { method: 'POST', body: body(input) }),
  cancelRun: (id: number) => request<{ ok: true }>(`/api/runs/${id}/cancel`, { method: 'POST' }),

  logs: (params: { runId?: number; afterId?: number; level?: string; search?: string; limit?: number }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return request<{ logs: LogEntry[]; lastId: number }>(`/api/logs?${query}`);
  },

  schedules: () => request<Schedule[]>('/api/schedules'),
  createSchedule: (input: Record<string, unknown>) =>
    request<Schedule>('/api/schedules', { method: 'POST', body: body(input) }),
  updateSchedule: (id: number, patch: Record<string, unknown>) =>
    request<Schedule>(`/api/schedules/${id}`, { method: 'PATCH', body: body(patch) }),
  deleteSchedule: (id: number) =>
    request<{ ok: true }>(`/api/schedules/${id}`, { method: 'DELETE' }),

  settings: () => request<{ settings: Settings; security: SecurityStatus }>('/api/settings'),
  updateSettings: (patch: Record<string, unknown>) =>
    request<{ settings: Settings }>('/api/settings', { method: 'PATCH', body: body(patch) }),
  rotateKey: () =>
    request<{ ok: true; security: SecurityStatus }>('/api/settings/rotate-key', { method: 'POST' }),
};
