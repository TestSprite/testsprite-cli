import { localValidationError } from './errors.js';
import { terminalWidth } from './ticker.js';

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

/**
 * Render `rows` as an aligned plain-text table over the selected columns.
 *
 * Column widths come from {@link measureTextColumns}, so cells are padded by
 * terminal display width (CJK/full-width aware) and a column always fits its
 * header and every rendered cell.
 *
 * @param rows - Data rows to render.
 * @param columns - Column definitions (all of them; `options.columns` selects).
 * @param options - `columns` selection string, `noHeader`, `separator`.
 * @returns The rendered table, newline-joined, with no trailing newline.
 */
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

/**
 * Resolve the user's `--columns` selection string against the full column set.
 *
 * Matching is case-insensitive and ignores non-alphanumerics
 * (see {@link textColumnKey}), so `"default-env"` selects `DEFAULT ENV`.
 *
 * @returns The selected columns in the requested order.
 * @throws {localValidationError} On an empty selection token or an unknown
 *   column key; the error's payload lists the valid keys.
 */
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

/**
 * Measure the final display width of each column.
 *
 * The declared width is a floor, measured however the caller likes (usually
 * `.length`). It is raised to the widest RENDERED cell and to the header,
 * both measured in terminal display columns: `.length` counts UTF-16 code
 * units, so an East-Asian full-width character (2 terminal cells, 1 code
 * unit) made a row containing it push every column to its right out of
 * alignment. Measuring rendered cells here fixes every table that goes
 * through this module, and an overlong cell widens its column instead of
 * overflowing it (a long ASCII value had the same misaligning effect
 * before). The header joins the floor too: `--columns` reordering can put a
 * narrow declared width in front of wider columns, and a header wider than
 * its own column overflowed it the same way.
 *
 * @param rows - The rows about to be rendered; their cells are measured.
 * @param columns - The selected column definitions.
 * @returns One display-column width per column, in column order.
 */
export function measureTextColumns<T>(
  rows: readonly T[],
  columns: readonly TextTableColumn<T>[],
): number[] {
  return columns.map(column => {
    let width = Math.max(
      terminalWidth(column.header),
      typeof column.width === 'function' ? column.width(rows) : column.width,
    );
    for (const row of rows) {
      const cellWidth = terminalWidth(column.render(row));
      if (cellWidth > width) width = cellWidth;
    }
    return width;
  });
}

/**
 * Format one table row: pad every value to its column's display width except
 * the last, joined by two spaces (the last column is left unpadded so the
 * line never carries trailing whitespace).
 */
export function formatTextTableRow(values: readonly string[], widths: readonly number[]): string {
  return values
    .map((value, index) => (index === values.length - 1 ? value : pad(value, widths[index] ?? 0)))
    .join('  ');
}

/** Lowercase and strip non-alphanumerics so `DEFAULT ENV` matches `default-env`. */
function textColumnKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Right-pad `value` with spaces up to `width` terminal display columns.
 * Measures display width (CJK/full-width = 2 cells), not UTF-16 length; a
 * value already at or beyond `width` is returned unchanged.
 */
function pad(value: string, width: number): string {
  const display = terminalWidth(value);
  if (display >= width) return value;
  return value + ' '.repeat(width - display);
}
