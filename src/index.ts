#!/usr/bin/env node
import { Command, Option } from 'commander';
import { AUDIT_CODES, runAudit } from './commands/audit.js';
import { METADATA_FIELDS, runMetadata } from './commands/metadata.js';
import { DEFAULT_TEMPLATE, runOrganize } from './commands/organize.js';
import { runRate } from './commands/rate.js';
import { AbsApiError } from './abs/client.js';
import { createContext } from './context.js';
import { log, setLogLevel } from './logger.js';
import { printTable } from './util/table.js';

const program = new Command();

program
  .name('abs-butler')
  .description('Manage and maintain an AudiobookShelf library.')
  .version('0.1.0')
  .option('-c, --config <path>', 'path to a config JSON file')
  .option('-l, --library <idOrName>', 'limit to one library (defaults to all book libraries)')
  .option('-v, --verbose', 'print debug logging')
  .option('-q, --quiet', 'only print errors')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) setLogLevel('debug');
    else if (opts.quiet) setLogLevel('error');
  });

const globals = () => program.opts();

program
  .command('libraries')
  .description('List the libraries on the server (also a quick connectivity check)')
  .action(async () => {
    const ctx = await createContext(globals());
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
  .option('--min-confidence <n>', 'confidence needed before a tag is written', Number, 0.35)
  .option('--max-age <n>', 'only show books banded above this reader age')
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
  .action(async (opts) => runOrganize({ ...globals(), ...opts }));

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof AbsApiError && (err.status === 401 || err.status === 403)) {
      log.error(err.message);
      log.error('Check ABS_TOKEN, or ABS_USERNAME/ABS_PASSWORD, in your .env.');
    } else {
      log.error((err as Error).message);
      if (process.env.DEBUG) log.error((err as Error).stack);
    }
    process.exitCode = 1;
  }
}

void main();
