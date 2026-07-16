import { localValidationError } from './errors.js';

export interface TextTableColumn<T> {
  header: string;
  width: number | ((rows: readonly T[]) => number);
  render: (row: T) => string;
}

export interface TextTableOptions {
  columns?: string;
  noHeader?: boolean;
  separator?: boolean;
}

export function renderTextTable<T>(
  rows: readonly T[],
  columns: readonly TextTableColumn<T>[],
  options: TextTableOptions = {},
): string {
  const selected = resolveTextColumns(options.columns, columns);
  const widths = measureTextColumns(rows, selected);
  const body = rows.map(row =>
    formatTextTableRow(
      selected.map(column => column.render(row)),
      widths,
    ),
  );

  if (options.noHeader === true) return body.join('\n');

  const header = formatTextTableRow(
    selected.map(column => column.header),
    widths,
  );
  return [header, ...(options.separator === true ? ['-'.repeat(header.length)] : []), ...body].join(
    '\n',
  );
}

export function resolveTextColumns<T>(
  raw: string | undefined,
  columns: readonly TextTableColumn<T>[],
): readonly TextTableColumn<T>[] {
  if (raw === undefined || raw.trim() === '') return columns;

  const byKey = new Map(columns.map(column => [textColumnKey(column.header), column]));
  const validKeys = columns.map(column => textColumnKey(column.header));
  const requested = raw.split(',').map(token => token.trim());

  if (requested.some(token => token.length === 0)) {
    throw localValidationError(
      'columns',
      `must be a comma-separated list of: ${validKeys.join(', ')}`,
      validKeys,
    );
  }

  return requested.map(token => {
    const key = textColumnKey(token);
    const column = byKey.get(key);
    if (column === undefined) {
      throw localValidationError(
        'columns',
        `unknown column "${token}"; must be one of: ${validKeys.join(', ')}`,
        validKeys,
      );
    }
    return column;
  });
}

export function measureTextColumns<T>(
  rows: readonly T[],
  columns: readonly TextTableColumn<T>[],
): number[] {
  return columns.map(column =>
    typeof column.width === 'function' ? column.width(rows) : column.width,
  );
}

export function formatTextTableRow(values: readonly string[], widths: readonly number[]): string {
  return values
    .map((value, index) => (index === values.length - 1 ? value : pad(value, widths[index] ?? 0)))
    .join('  ');
}

function textColumnKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + ' '.repeat(width - value.length);
}
