/** Minimal leveled logger. Everything but data output goes to stderr, so `--json` stays pipeable. */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
export type LogLevel = keyof typeof LEVELS;

let current: LogLevel = 'info';
let useColor = process.stderr.isTTY && !process.env.NO_COLOR;

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function setColor(enabled: boolean): void {
  useColor = enabled;
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

function emit(level: Exclude<LogLevel, 'silent'>, prefix: string, args: unknown[]): void {
  if (LEVELS[current] < LEVELS[level]) return;
  console.error(prefix, ...args);
}

export const log = {
  error: (...args: unknown[]) => emit('error', color.red('✖'), args),
  warn: (...args: unknown[]) => emit('warn', color.yellow('!'), args),
  info: (...args: unknown[]) => emit('info', color.blue('·'), args),
  success: (...args: unknown[]) => emit('info', color.green('✔'), args),
  debug: (...args: unknown[]) => emit('debug', color.dim('debug'), args),
  /** Data destined for a pipe. Always stdout, never suppressed by log level. */
  out: (text: string) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
};
