/** Typed client for the abs-butler API. All calls are same-origin. */

export interface ServerKeyStatus {
  encrypted: boolean;
  masked: string;
}

export interface LocalRootStatus {
  /** False means file organization is unavailable for this server, full stop. */
  canManageFiles: boolean;
  access: 'read-write' | 'read-only' | 'unreachable' | 'not-configured';
  reason: string;
  path: string | null;
}

export interface Server {
  id: number;
  name: string;
  url: string;
  libraryRoot: string | null;
  pathPrefix: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  key: ServerKeyStatus;
  files: LocalRootStatus;
}

export type RunCommand = 'audit' | 'rate' | 'metadata' | 'organize';
export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

export interface Run {
  id: number;
  serverId: number | null;
  serverName?: string;
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
  serverId: number;
  serverName?: string;
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
  access: 'read-write' | 'read-only' | 'unreachable' | 'not-configured';
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
  requireDryRunFirst: boolean;
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
  authStatus: () =>
    request<{ authRequired: boolean; authenticated: boolean; encryptionEnabled: boolean }>(
      '/api/auth/status',
    ),
  login: (password: string) =>
    request<{ ok: true }>('/api/auth/login', { method: 'POST', body: body({ password }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  meta: () => request<Meta>('/api/meta'),

  servers: () => request<Server[]>('/api/servers'),
  createServer: (input: Record<string, unknown>) =>
    request<Server>('/api/servers', { method: 'POST', body: body(input) }),
  updateServer: (id: number, patch: Record<string, unknown>) =>
    request<Server>(`/api/servers/${id}`, { method: 'PATCH', body: body(patch) }),
  deleteServer: (id: number) => request<{ ok: true }>(`/api/servers/${id}`, { method: 'DELETE' }),
  capability: (id: number) => request<CapabilityReport>(`/api/servers/${id}/capability`),

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
  startRun: (input: { serverId: number; command: RunCommand; options: Record<string, unknown> }) =>
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

  settings: () =>
    request<{ settings: Settings; encryptionEnabled: boolean; authRequired: boolean }>('/api/settings'),
  updateSettings: (patch: Record<string, unknown>) =>
    request<{ settings: Settings }>('/api/settings', { method: 'PATCH', body: body(patch) }),
};
