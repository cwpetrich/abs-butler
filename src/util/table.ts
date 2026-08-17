import { log } from '../logger.js';

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  align?: 'left' | 'right';
  maxWidth?: number;
}

const ANSI = /\u001b\[[0-9;]*m/g;

function visibleLength(value: string): number {
  return value.replace(ANSI, '').length;
}

function pad(value: string, width: number, align: 'left' | 'right'): string {
  const gap = Math.max(0, width - visibleLength(value));
  return align === 'right' ? ' '.repeat(gap) + value : value + ' '.repeat(gap);
}

/** Renders a plain-text table to stdout. Empty input prints nothing. */
export function printTable<T>(rows: T[], columns: Column<T>[]): void {
  if (rows.length === 0) return;

  const cells = rows.map((row) =>
    columns.map((col) => {
      const raw = col.value(row) ?? '';
      if (col.maxWidth && visibleLength(raw) > col.maxWidth) {
        return `${raw.slice(0, col.maxWidth - 1)}…`;
      }
      return raw;
    }),
  );

  const widths = columns.map((col, i) =>
    Math.max(visibleLength(col.header), ...cells.map((row) => visibleLength(row[i] ?? ''))),
  );

  const line = (values: string[]) =>
    values
      .map((value, i) => pad(value, widths[i]!, columns[i]?.align ?? 'left'))
      .join('  ')
      .trimEnd();

  log.out(line(columns.map((c) => c.header)));
  log.out(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of cells) log.out(line(row));
}

export function printJson(value: unknown): void {
  log.out(JSON.stringify(value, null, 2));
}
