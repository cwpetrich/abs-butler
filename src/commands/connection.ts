import { AbsClient } from '../abs/client.js';
import { assessCapability } from '../core/capability.js';
import { keyFilePath, keySource } from '../core/crypto.js';
import { openStore } from '../context.js';
import {
  deleteConnection,
  getConnection,
  getConnectionWithKey,
  saveConnection,
  updateConnection,
} from '../db/connection.js';
import { getSettings, updateSettings } from '../db/settings.js';
import { color, log } from '../logger.js';
import { printJson, printTable } from '../util/table.js';

export interface ConnectOptions {
  url: string;
  apiKey: string;
  libraryRoot?: string;
  pathPrefix?: string;
  json?: boolean;
  /** Skip the connectivity check before saving. */
  noVerify?: boolean;
}

/**
 * Sets the AudiobookShelf connection from the CLI.
 *
 * The web UI is the usual way to do this; this exists for headless setup and
 * for scripting a fresh install.
 */
export async function runConnect(options: ConnectOptions): Promise<void> {
  const db = openStore();

  if (!options.noVerify) {
    log.info(`checking ${options.url}…`);
    const libraries = await new AbsClient({
      baseUrl: options.url,
      token: options.apiKey,
    }).listLibraries();
    log.success(`connected — ${libraries.length} librar(ies) visible`);
  }

  const connection = saveConnection(db, {
    url: options.url,
    apiKey: options.apiKey,
    libraryRoot: options.libraryRoot ?? null,
    pathPrefix: options.pathPrefix ?? null,
  });

  log.debug(
    `API key encrypted with ${keySource() === 'env' ? 'BUTLER_SECRET' : keyFilePath()}`,
  );

  if (options.json) printJson(connection);
  else log.success(`Connected to ${connection.url}.`);
}

export interface ConfigureOptions {
  url?: string;
  apiKey?: string;
  libraryRoot?: string;
  pathPrefix?: string;
  /** 'on' or 'off'; undefined leaves the setting alone. */
  fileChanges?: string;
}

export async function runConfigure(options: ConfigureOptions): Promise<void> {
  const db = openStore();

  // Settable without a connection: it is a property of this install, not of the
  // server, and a headless setup may well want it set before connecting.
  if (options.fileChanges !== undefined) {
    if (options.fileChanges !== 'on' && options.fileChanges !== 'off') {
      throw new Error(`--file-changes expects "on" or "off" (got "${options.fileChanges}")`);
    }
    const allowFileChanges = options.fileChanges === 'on';
    updateSettings(db, { allowFileChanges });
    if (allowFileChanges) log.warn('File changes are ON: organize --apply can now move files.');
    else log.success('File changes are OFF: organize --apply will be refused.');
  }

  const connectionPatch = {
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.libraryRoot !== undefined ? { libraryRoot: options.libraryRoot } : {}),
    ...(options.pathPrefix !== undefined ? { pathPrefix: options.pathPrefix } : {}),
  };
  if (Object.keys(connectionPatch).length === 0) return;

  if (!getConnection(db)) {
    throw new Error('Not connected yet. Run: abs-butler connect --url <url> --api-key <key>');
  }
  const updated = updateConnection(db, connectionPatch);
  log.success(`Updated the connection to ${updated.url}.`);
}

export async function runDisconnect(): Promise<void> {
  const db = openStore();
  if (!getConnection(db)) throw new Error('Not connected.');
  deleteConnection(db);
  log.success('Disconnected. Run history and settings are kept.');
}

/**
 * Connectivity plus a filesystem capability report — the answer to
 * "can this machine actually organize the files?"
 */
export async function runStatus(options: { json?: boolean } = {}): Promise<void> {
  const db = openStore();
  const connection = getConnection(db);
  if (!connection) {
    throw new Error('Not connected yet. Run: abs-butler connect --url <url> --api-key <key>');
  }
  const withKey = getConnectionWithKey(db)!;

  const client = new AbsClient({ baseUrl: withKey.url, token: withKey.apiKey });
  try {
    const libraries = await client.listLibraries();
    const capability = assessCapability(connection, libraries);

    const { allowFileChanges } = getSettings(db);

    if (options.json) {
      printJson({
        url: connection.url,
        reachable: true,
        libraries: libraries.length,
        allowFileChanges,
        capability,
      });
      return;
    }

    log.success(`${connection.url}: connected, ${libraries.length} librar(ies)`);
    if (capability.canManageFiles) log.success(`files: ${capability.reason}`);
    else log.warn(`files: ${capability.reason}`);

    // Reachable files and permission to change them are separate gates, and
    // organize needs both — so reporting only one of them would mislead.
    if (allowFileChanges) log.warn('file changes: allowed — organize --apply will move files');
    else log.info('file changes: off — organize can plan but not apply (configure --file-changes on)');

    if (capability.libraries.length > 0) {
      printTable(capability.libraries, [
        { header: 'LIBRARY', value: (l) => l.libraryName },
        { header: 'ABS PATH', value: (l) => l.absPath },
        { header: 'HERE', value: (l) => l.localPath ?? color.dim('—') },
        {
          header: 'ACCESS',
          value: (l) =>
            l.access === 'read-write' ? color.green(l.access) : color.yellow(l.access),
        },
      ]);
    }
  } catch (err) {
    if (options.json) {
      printJson({ url: connection.url, reachable: false, error: (err as Error).message });
      return;
    }
    log.error(`${connection.url}: ${(err as Error).message}`);
    throw err;
  }
}
