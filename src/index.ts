#!/usr/bin/env node
// Must precede every other import: see the module for why.
import './silence-warnings.js';
import { Command, Option } from 'commander';
import { AbsApiError } from './abs/client.js';
import { runAudit } from './commands/audit.js';
import { runMetadata, METADATA_FIELDS } from './commands/metadata.js';
import { runOrganize } from './commands/organize.js';
import { runRate } from './commands/rate.js';
import {
  runServerAdd,
  runServerList,
  runServerRemove,
  runServerTest,
  runServerUpdate,
} from './commands/servers.js';
import { AUDIT_CODES } from './core/audit.js';
import { DEFAULT_TEMPLATE } from './core/organize.js';
import { loadWebConfig } from './config.js';
import { openStore } from './context.js';
import { closeDb, databasePath } from './db/index.js';
import { listServers } from './db/servers.js';
import { log, setLogLevel } from './logger.js';
import { printTable } from './util/table.js';
import { startWebServer } from './web/server.js';

const program = new Command();

program
  .name('abs-butler')
  .description('Manage and maintain one or many AudiobookShelf servers.')
  .version('0.2.0')
  .option('-s, --server <idOrName>', 'which configured server to act on')
  .option('-l, --library <idOrName>', 'limit to one library (defaults to all book libraries)')
  .option('-v, --verbose', 'print debug logging')
  .option('-q, --quiet', 'only print errors')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) setLogLevel('debug');
    else if (opts.quiet) setLogLevel('error');
  });

const globals = () => program.opts();

// ---------------------------------------------------------------------------
// Server management
// ---------------------------------------------------------------------------

const servers = program.command('server').description('Add and manage AudiobookShelf servers');

servers
  .command('add')
  .description('Register a server by URL and API key')
  .requiredOption('--name <name>', 'a short name you will use to refer to it')
  .requiredOption('--url <url>', 'base URL, e.g. http://localhost:13378')
  .requiredOption('--api-key <key>', 'API token from Settings → Users → your user')
  .option('--library-root <path>', 'where this machine sees the media (omit for API-only management)')
  .option('--path-prefix <path>', 'the path AudiobookShelf itself reports, if it differs')
  .option('--no-verify', 'skip the connectivity check before saving')
  .option('--json', 'emit JSON')
  .action(async (opts) => runServerAdd({ ...opts, noVerify: opts.verify === false }));

servers
  .command('list')
  .description('List configured servers')
  .option('--json', 'emit JSON')
  .action(async (opts) => runServerList(opts));

servers
  .command('update <idOrName>')
  .description('Change a server’s settings')
  .option('--name <name>')
  .option('--url <url>')
  .option('--api-key <key>')
  .option('--library-root <path>')
  .option('--path-prefix <path>')
  .option('--enable')
  .option('--disable')
  .action(async (idOrName, opts) => runServerUpdate(idOrName, opts));

servers
  .command('remove <idOrName>')
  .description('Remove a server and its run history')
  .action(async (idOrName) => runServerRemove(idOrName));

servers
  .command('test [idOrName]')
  .description('Check connectivity and whether files are manageable from this machine')
  .option('--json', 'emit JSON')
  .action(async (idOrName, opts) => runServerTest(idOrName, opts));

// ---------------------------------------------------------------------------
// Library maintenance
// ---------------------------------------------------------------------------

program
  .command('libraries')
  .description('List the libraries on a server')
  .action(async () => {
    const { openServerContext } = await import('./context.js');
    const db = openStore();
    const ctx = openServerContext(db, globals().server);
    const libraries = await ctx.client.listLibraries();
    printTable(libraries, [
      { header: 'NAME', value: (l) => l.name },
      { header: 'TYPE', value: (l) => l.mediaType },
      { header: 'ID', value: (l) => l.id },
      { header: 'FOLDERS', value: (l) => l.folders.map((f) => f.fullPath).join(', ') },
    ]);
  });

program
  .command('audit')
  .description('Report metadata and file problems across the library')
  .option('--json', 'emit JSON instead of a table')
  .option('--details', 'list every affected item, not just counts')
  .addOption(new Option('--only <codes...>', 'restrict to these issue codes').choices(AUDIT_CODES))
  .option('--limit <n>', 'stop after N items (for a quick look)', Number)
  .action(async (opts) => runAudit({ ...globals(), ...opts }));

program
  .command('rate')
  .description('Derive age bands and content flags from external sources, and tag books with them')
  .option('--apply', 'write tags to AudiobookShelf (default is a dry run)')
  .option('--json', 'emit JSON instead of a table')
  .option('--force', 're-rate items that already carry abs-butler tags')
  .option('--providers <names...>', 'restrict to these providers')
  .option('--min-confidence <n>', 'confidence needed before a tag is written', Number)
  .option('--max-age <n>', 'only show books banded above this reader age', Number)
  .option('--limit <n>', 'stop after N items', Number)
  .action(async (opts) => runRate({ ...globals(), ...opts }));

program
  .command('metadata')
  .description('Fill in blank metadata fields from external providers')
  .option('--apply', 'write changes to AudiobookShelf (default is a dry run)')
  .option('--json', 'emit JSON instead of a table')
  .option('--overwrite', 'replace fields that already have a value')
  .addOption(new Option('--fields <names...>', 'fields to fill').choices(METADATA_FIELDS))
  .option('--providers <names...>', 'restrict to these providers')
  .option('--limit <n>', 'stop after N items', Number)
  .action(async (opts) => runMetadata({ ...globals(), ...opts }));

program
  .command('organize')
  .description('Move book folders on disk into a consistent naming scheme')
  .option('--apply', 'actually move files (default is a dry run)')
  .option('--json', 'emit JSON instead of a table')
  .option('--template <pattern>', `path template (default: ${DEFAULT_TEMPLATE})`, DEFAULT_TEMPLATE)
  .option('--no-scan', 'skip the library rescan after moving')
  .option('--limit <n>', 'stop after N items', Number)
  .action(async (opts) => runOrganize({ ...globals(), ...opts, noScan: opts.scan === false }));

// ---------------------------------------------------------------------------
// Web UI
// ---------------------------------------------------------------------------

program
  .command('serve')
  .description('Run the web UI and background job scheduler')
  .option('--port <n>', 'port to listen on (default 8478, or BUTLER_PORT)', Number)
  .option('--host <host>', 'address to bind (default 0.0.0.0, or BUTLER_HOST)')
  .action(async (opts) => {
    const db = openStore();
    const config = loadWebConfig();
    if (opts.port) config.port = opts.port;
    if (opts.host) config.host = opts.host;

    log.info(`database: ${databasePath()}`);
    const configured = listServers(db);
    if (configured.length === 0) {
      log.warn('No servers configured yet — add one from the web UI once it starts.');
    } else {
      log.info(`managing ${configured.length} server(s): ${configured.map((s) => s.name).join(', ')}`);
    }

    const web = await startWebServer(db, config);

    // Keep the process alive until signalled, then shut down cleanly so an
    // in-flight run finishes writing its log rather than being truncated.
    await new Promise<void>((resolve) => {
      const shutdown = (signal: string) => {
        log.info(`received ${signal}, shutting down…`);
        void web.close().then(() => {
          closeDb();
          resolve();
        });
      };
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      process.once('SIGINT', () => shutdown('SIGINT'));
    });
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof AbsApiError && (err.status === 401 || err.status === 403)) {
      log.error(err.message);
      log.error('Check the API key for this server: abs-butler server test');
    } else {
      log.error((err as Error).message);
      if (process.env.DEBUG) log.error((err as Error).stack);
    }
    process.exitCode = 1;
  }
}

void main();
