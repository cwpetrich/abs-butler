#!/usr/bin/env node
// Must precede every other import: see the module for why.
import './silence-warnings.js';
import { Command, Option } from 'commander';
import { VERSION } from './version.js';
import { AbsApiError } from './abs/client.js';
import { runAudit } from './commands/audit.js';
import { runMetadata, METADATA_FIELDS } from './commands/metadata.js';
import { runNormalize, NORMALIZE_FIELDS } from './commands/normalize.js';
import { runOrganize } from './commands/organize.js';
import { runRevert, runRunsList } from './commands/revert.js';
import { runRate } from './commands/rate.js';
import {
  runConfigure,
  runConnect,
  runDisconnect,
  runStatus,
} from './commands/connection.js';
import { AUDIT_CODES } from './core/audit.js';
import { DEFAULT_TEMPLATE } from './core/organize.js';
import { loadWebConfig } from './config.js';
import { openStore } from './context.js';
import { closeDb, databasePath } from './db/index.js';
import { getConnection } from './db/connection.js';
import { log, setLogLevel } from './logger.js';
import { printTable } from './util/table.js';
import { startWebServer } from './web/server.js';

const program = new Command();

program
  .name('abs-butler')
  .description('Keep one AudiobookShelf library clean, enriched, and organized.')
  .version(VERSION)
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
// Connection
// ---------------------------------------------------------------------------

program
  .command('connect')
  .description('Point abs-butler at your AudiobookShelf server')
  .requiredOption('--url <url>', 'base URL, e.g. http://localhost:13378')
  .option('--api-key <key>', 'API token from Settings → Users → your user (preferred)')
  .option('--username <name>', 'admin username, instead of --api-key')
  .option('--password <password>', 'admin password; prompted for if omitted, never stored')
  .option('--library-root <path>', 'where this machine sees the media (needed for organize)')
  .option('--path-prefix <path>', 'the path AudiobookShelf itself reports, if it differs')
  .option('--no-verify', 'skip the connectivity check before saving')
  .option('--json', 'emit JSON')
  .action(async (opts) => runConnect({ ...opts, noVerify: opts.verify === false }));

program
  .command('configure')
  .description('Change the connection, or what abs-butler is allowed to change')
  .option('--url <url>')
  .option('--api-key <key>')
  .option('--username <name>', 'admin username, instead of --api-key')
  .option('--password <password>', 'admin password; prompted for if omitted, never stored')
  .option('--library-root <path>')
  .option('--path-prefix <path>')
  .option('--file-changes <on|off>', 'allow or refuse organize --apply on this install')
  .option('--metadata-rewrite <on|off>', 'allow or refuse normalize --apply on this install')
  .action(async (opts) => runConfigure(opts));

program
  .command('status')
  .description('Check connectivity and whether files are manageable from this machine')
  .option('--json', 'emit JSON')
  .action(async (opts) => runStatus(opts));

program
  .command('disconnect')
  .description('Forget the AudiobookShelf connection')
  .action(async () => runDisconnect());

// ---------------------------------------------------------------------------
// Library maintenance
// ---------------------------------------------------------------------------

program
  .command('libraries')
  .description('List the libraries on a server')
  .action(async () => {
    const { openContext } = await import('./context.js');
    const db = openStore();
    const ctx = openContext(db);
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
  .option('--details', 'list every audited item and its issues, not just counts')
  .option('--only-issues', 'with --details, leave out the items that passed')
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
  .command('normalize')
  .description('Make titles, authors, narrators and series names consistent across the library')
  .option('--apply', 'write changes to AudiobookShelf (default is a dry run)')
  .option('--json', 'emit JSON instead of a table')
  .addOption(new Option('--fields <names...>', 'fields to normalize').choices(NORMALIZE_FIELDS))
  .option('--providers <names...>', 'restrict to these providers')
  .option('--no-consensus', 'ignore what the rest of the library spells, and use providers only')
  .option('--limit <n>', 'stop after N items', Number)
  .action(async (opts) =>
    runNormalize({ ...globals(), ...opts, noConsensus: opts.consensus === false }),
  );

program
  .command('organize')
  .description('Move book folders on disk into a consistent naming scheme')
  .option('--apply', 'actually move files (default is a dry run)')
  .option('--json', 'emit JSON instead of a table')
  .option('--template <pattern>', `path template (default: ${DEFAULT_TEMPLATE})`, DEFAULT_TEMPLATE)
  .option('--no-scan', 'skip the library rescan after moving')
  .option('--limit <n>', 'stop after N items', Number)
  .action(async (opts) => runOrganize({ ...globals(), ...opts, noScan: opts.scan === false }));

program
  .command('runs')
  .description('Recent runs, with what can still be undone')
  .option('--json', 'emit JSON instead of a table')
  .option('--limit <n>', 'how many to show (default 20)', Number)
  .action(async (opts) => runRunsList(opts));

program
  .command('revert <runId>')
  .description('Put back what a run changed')
  .option('--apply', 'actually restore (default is a dry run)')
  .option('--force', 'restore even where the item has been edited since')
  .option('--json', 'emit JSON instead of a table')
  .action(async (runId, opts) => runRevert(runId, opts));

// ---------------------------------------------------------------------------
// Web UI
// ---------------------------------------------------------------------------

program
  .command('serve')
  .description('Run the web UI and background job scheduler')
  .option('--port <n>', 'port to listen on (default 13380, or BUTLER_PORT)', Number)
  .option('--host <host>', 'address to bind (default 0.0.0.0, or BUTLER_HOST)')
  .action(async (opts) => {
    const db = openStore();
    const config = loadWebConfig();
    if (opts.port) config.port = opts.port;
    if (opts.host) config.host = opts.host;

    log.info(`database: ${databasePath()}`);
    const connection = getConnection(db);
    if (connection) log.info(`managing ${connection.url}`);
    else log.warn('Not connected to AudiobookShelf yet — set it up in the web UI once it starts.');

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
      log.error('Check the API key: abs-butler status');
    } else {
      const message = (err as Error).message;
      log.error(message);
      // SQLite's own wording is accurate and unactionable; say who owns the
      // database and what to do about it.
      if (/readonly database|unable to open database/i.test(message)) {
        const { explainReadonlyDatabase } = await import('./core/deployment.js');
        const { resolveDataDir } = await import('./db/index.js');
        const hint = explainReadonlyDatabase(resolveDataDir());
        if (hint) log.error(hint);
      }
      if (process.env.DEBUG) log.error((err as Error).stack);
    }
    process.exitCode = 1;
  }
}

void main();
