import { AsyncLocalStorage } from 'node:async_hooks';
import { inspect } from 'node:util';

/** Minimal leveled logger. Everything but data output goes to stderr, so `--json` stays pipeable. */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
export type LogLevel = keyof typeof LEVELS;

/** What a log line is tagged with. `success` is styled apart but gated as info. */
export type LogKind = 'error' | 'warn' | 'info' | 'success' | 'debug';

export interface LogEntry {
  level: LogKind;
  message: string;
}

export type LogSink = (entry: LogEntry) => void;

let current: LogLevel = 'info';
let useColor = process.stderr.isTTY && !process.env.NO_COLOR;

/**
 * The sink for the currently executing job. AsyncLocalStorage rather than a
 * module-level variable so a background job's output can never bleed into a
 * concurrent web request's, whatever the interleaving.
 */
const sinkStorage = new AsyncLocalStorage<LogSink>();

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

export function setColor(enabled: boolean): void {
  useColor = enabled;
}

/** Runs `fn` with every log line inside it also delivered to `sink`. */
export function withLogSink<T>(sink: LogSink, fn: () => Promise<T>): Promise<T> {
  return sinkStorage.run(sink, fn);
}

function paint(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const color = {
  dim: (t: string) => paint('2', t),
  bold: (t: string) => paint('1', t),
  red: (t: string) => paint('31', t),
  green: (t: string) => paint('32', t),
  yellow: (t: string) => paint('33', t),
  blue: (t: string) => paint('34', t),
  cyan: (t: string) => paint('36', t),
};

const ANSI = /\u001b\[[0-9;]*m/g;

function format(args: unknown[]): string {
  return args
    .map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 3, colors: false })))
    .join(' ')
    .replace(ANSI, '');
}

function emit(kind: LogKind, gate: Exclude<LogLevel, 'silent'>, prefix: string, args: unknown[]): void {
  const sink = sinkStorage.getStore();
  // A sink records everything at info and above regardless of console verbosity:
  // the stored run log should not depend on whether someone passed --verbose.
  if (sink && (kind !== 'debug' || LEVELS[current] >= LEVELS.debug)) {
    sink({ level: kind, message: format(args) });
  }
  if (LEVELS[current] < LEVELS[gate]) return;
  console.error(prefix, ...args);
}

export const log = {
  error: (...args: unknown[]) => emit('error', 'error', color.red('✖'), args),
  warn: (...args: unknown[]) => emit('warn', 'warn', color.yellow('!'), args),
  info: (...args: unknown[]) => emit('info', 'info', color.blue('·'), args),
  success: (...args: unknown[]) => emit('success', 'info', color.green('✔'), args),
  debug: (...args: unknown[]) => emit('debug', 'debug', color.dim('debug'), args),
  /** Data destined for a pipe. Always stdout, never suppressed by log level. */
  out: (text: string) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
};
