import { AbsClient, resolveApiKey } from '../abs/client.js';
import { gatherCredentials, terminalPrompts, type CredentialPrompts } from './credentials.js';
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
  /** Either this, or username + password. */
  apiKey?: string;
  username?: string;
  password?: string;
  libraryRoot?: string;
  pathPrefix?: string;
  json?: boolean;
  /** Skip the connectivity check before saving. */
  noVerify?: boolean;
  /** Injected in tests; defaults to the real terminal. */
  prompts?: CredentialPrompts;
}

/**
 * Sets the AudiobookShelf connection from the CLI.
 *
 * The web UI is the usual way to do this; this exists for headless setup and
 * for scripting a fresh install.
 *
 * Takes an API token or a username and password, asking for whichever is
 * missing when there is a terminal to ask. Only ever stores a token — see
 * `resolveApiKey`. Passing a password as a flag leaves it in the shell
 * history, so the prompt is the better habit for anything typed by hand.
 */
export async function runConnect(options: ConnectOptions): Promise<void> {
  const db = openStore();

  const credentials = await gatherCredentials(options, options.prompts ?? terminalPrompts, {
    required: true,
  });
  const apiKey = await resolveApiKey(options.url, credentials);
  if (!credentials.apiKey) log.info('logged in; storing the API token, not the password');

  if (!options.noVerify) {
    log.info(`checking ${options.url}…`);
    const libraries = await new AbsClient({
      baseUrl: options.url,
      token: apiKey,
    }).listLibraries();
    log.success(`connected — ${libraries.length} librar(ies) visible`);
  }

  const connection = saveConnection(db, {
    url: options.url,
    apiKey,
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
  username?: string;
  password?: string;
  /** Injected in tests; defaults to the real terminal. */
  prompts?: CredentialPrompts;
  libraryRoot?: string;
  pathPrefix?: string;
  /** 'on' or 'off'; undefined leaves the setting alone. */
  fileChanges?: string;
  /** 'on' or 'off'; undefined leaves the setting alone. */
  metadataRewrite?: string;
}

/** Shared parsing so both switches reject the same values the same way. */
function parseSwitch(flag: string, value: string): boolean {
  if (value !== 'on' && value !== 'off') {
    throw new Error(`${flag} expects "on" or "off" (got "${value}")`);
  }
  return value === 'on';
}

export async function runConfigure(options: ConfigureOptions): Promise<void> {
  const db = openStore();

  // Settable without a connection: it is a property of this install, not of the
  // server, and a headless setup may well want it set before connecting.
  if (options.fileChanges !== undefined) {
    const allowFileChanges = parseSwitch('--file-changes', options.fileChanges);
    updateSettings(db, { allowFileChanges });
    if (allowFileChanges) log.warn('File changes are ON: organize --apply can now move files.');
    else log.success('File changes are OFF: organize --apply will be refused.');
  }

  if (options.metadataRewrite !== undefined) {
    const allowMetadataRewrite = parseSwitch('--metadata-rewrite', options.metadataRewrite);
    updateSettings(db, { allowMetadataRewrite });
    if (allowMetadataRewrite) {
      log.warn('Metadata rewrite is ON: normalize --apply can now replace titles and names.');
    } else {
      log.success('Metadata rewrite is OFF: normalize --apply will be refused.');
    }
  }

  const existing = getConnection(db);
  // Only asks when a username was given: configure is just as often being used
  // to change a path, and that must not turn into a password prompt.
  const credentials = await gatherCredentials(options, options.prompts ?? terminalPrompts, {
    required: false,
  });
  // A password is exchanged for a token against the server the connection will
  // point at after this call, which may be the one being set in the same run.
  const apiKey = credentials.username
    ? await resolveApiKey(options.url ?? existing?.url ?? '', credentials)
    : (credentials.apiKey ?? undefined);

  const connectionPatch = {
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(options.libraryRoot !== undefined ? { libraryRoot: options.libraryRoot } : {}),
    ...(options.pathPrefix !== undefined ? { pathPrefix: options.pathPrefix } : {}),
  };
  if (Object.keys(connectionPatch).length === 0) return;

  if (!existing) {
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

    const { allowFileChanges, allowMetadataRewrite } = getSettings(db);

    if (options.json) {
      printJson({
        url: connection.url,
        reachable: true,
        libraries: libraries.length,
        allowFileChanges,
        allowMetadataRewrite,
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

    if (allowMetadataRewrite) log.warn('metadata rewrite: allowed — normalize --apply will replace names');
    else log.info('metadata rewrite: off — normalize can plan but not apply (configure --metadata-rewrite on)');

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
