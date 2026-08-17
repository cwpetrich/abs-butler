import { AbsClient } from '../abs/client.js';
import { assessCapability } from '../core/capability.js';
import { hasSecret } from '../core/crypto.js';
import { openStore } from '../context.js';
import {
  createServer,
  deleteServer,
  findServer,
  getServerWithKey,
  listServers,
  serverKeyStatus,
  updateServer,
} from '../db/servers.js';
import { color, log } from '../logger.js';
import { printJson, printTable } from '../util/table.js';

export interface ServerAddOptions {
  name: string;
  url: string;
  apiKey: string;
  libraryRoot?: string;
  pathPrefix?: string;
  json?: boolean;
  /** Skip the connectivity check before saving. */
  noVerify?: boolean;
}

export async function runServerAdd(options: ServerAddOptions): Promise<void> {
  const db = openStore();

  if (!options.noVerify) {
    log.info(`checking ${options.url}…`);
    const client = new AbsClient({ baseUrl: options.url, token: options.apiKey });
    const libraries = await client.listLibraries();
    log.success(`connected — ${libraries.length} librar(ies) visible`);
  }

  const server = createServer(db, {
    name: options.name,
    url: options.url,
    apiKey: options.apiKey,
    libraryRoot: options.libraryRoot ?? null,
    pathPrefix: options.pathPrefix ?? null,
  });

  if (!hasSecret()) {
    log.warn('BUTLER_SECRET is not set, so this API key is stored unencrypted in the database.');
  }

  if (options.json) printJson(server);
  else log.success(`Added server "${server.name}" (id ${server.id}).`);
}

export async function runServerList(options: { json?: boolean } = {}): Promise<void> {
  const db = openStore();
  const servers = listServers(db);

  if (options.json) {
    printJson(servers.map((s) => ({ ...s, key: serverKeyStatus(db, s.id) })));
    return;
  }
  if (servers.length === 0) {
    log.info('No servers configured. Add one with: abs-butler server add --help');
    return;
  }

  printTable(servers, [
    { header: 'ID', value: (s) => String(s.id), align: 'right' },
    { header: 'NAME', value: (s) => s.name },
    { header: 'URL', value: (s) => s.url },
    { header: 'FILES', value: (s) => (s.libraryRoot ? s.libraryRoot : color.dim('api-only')) },
    { header: 'KEY', value: (s) => (serverKeyStatus(db, s.id).encrypted ? color.green('encrypted') : color.yellow('plaintext')) },
    { header: 'STATUS', value: (s) => (s.enabled ? color.green('enabled') : color.dim('disabled')) },
  ]);
}

export async function runServerRemove(idOrName: string): Promise<void> {
  const db = openStore();
  const server = findServer(db, idOrName);
  if (!server) throw new Error(`No server matching "${idOrName}".`);
  deleteServer(db, server.id);
  log.success(`Removed "${server.name}" and its run history.`);
}

export interface ServerUpdateOptions {
  name?: string;
  url?: string;
  apiKey?: string;
  libraryRoot?: string;
  pathPrefix?: string;
  enable?: boolean;
  disable?: boolean;
}

export async function runServerUpdate(idOrName: string, options: ServerUpdateOptions): Promise<void> {
  const db = openStore();
  const server = findServer(db, idOrName);
  if (!server) throw new Error(`No server matching "${idOrName}".`);

  const updated = updateServer(db, server.id, {
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.libraryRoot !== undefined ? { libraryRoot: options.libraryRoot } : {}),
    ...(options.pathPrefix !== undefined ? { pathPrefix: options.pathPrefix } : {}),
    ...(options.enable ? { enabled: true } : {}),
    ...(options.disable ? { enabled: false } : {}),
  });
  log.success(`Updated "${updated.name}".`);
}

/**
 * Connectivity plus a filesystem capability report — the answer to
 * "can this machine actually organize files on that server?"
 */
export async function runServerTest(idOrName?: string, options: { json?: boolean } = {}): Promise<void> {
  const db = openStore();
  const servers = idOrName
    ? [findServer(db, idOrName) ?? (() => { throw new Error(`No server matching "${idOrName}".`); })()]
    : listServers(db);

  if (servers.length === 0) throw new Error('No servers configured.');

  const report = [];
  for (const server of servers) {
    const withKey = getServerWithKey(db, server.id)!;
    const client = new AbsClient({ baseUrl: withKey.url, token: withKey.apiKey });
    try {
      const libraries = await client.listLibraries();
      const capability = assessCapability(server, libraries);
      report.push({ server: server.name, reachable: true, libraries: libraries.length, capability });

      if (!options.json) {
        log.success(`${server.name}: connected, ${libraries.length} librar(ies)`);
        if (capability.canManageFiles) log.success(`  files: ${capability.reason}`);
        else log.warn(`  files: ${capability.reason}`);
        for (const lib of capability.libraries) {
          const mark = lib.access === 'read-write' ? color.green('rw') : color.yellow(lib.access);
          log.info(`    [${mark}] ${lib.libraryName}: ${lib.absPath}${lib.localPath ? ` → ${lib.localPath}` : ''}`);
        }
      }
    } catch (err) {
      report.push({ server: server.name, reachable: false, error: (err as Error).message });
      if (!options.json) log.error(`${server.name}: ${(err as Error).message}`);
    }
  }

  if (options.json) printJson(report);
}
