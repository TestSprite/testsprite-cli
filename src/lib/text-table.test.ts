import { describe, expect, it } from 'vitest';
import { terminalWidth } from './ticker.js';
import {
  formatTextTableRow,
  measureTextColumns,
  renderTextTable,
  type TextTableColumn,
} from './text-table.js';

interface Row {
  id: string;
  name: string;
  type: string;
}

const CJK_NAME = '登录支付流程验证测试'; // 10 code units, 20 terminal cells

const columns: ReadonlyArray<TextTableColumn<Row>> = [
  { header: 'ID', width: 8, render: r => r.id },
  {
    header: 'NAME',
    width: rows => Math.max(4, ...rows.map(r => r.name.length)),
    render: r => r.name,
  },
  { header: 'TYPE', width: 8, render: r => r.type },
];

const typeIndex = (line: string): number => line.indexOf('frontend');

describe('renderTextTable', () => {
  // String indexes can't assert alignment: a CJK row legitimately carries
  // fewer UTF-16 units for the same number of terminal cells. Compare the
  // DISPLAY width of the prefix before the column instead.
  const cellOffset = (line: string, needle: string): number => {
    const idx = line.indexOf(needle);
    expect(idx).toBeGreaterThan(-1);
    return terminalWidth(line.slice(0, idx));
  };

  it('keeps columns aligned when a cell contains full-width (CJK) characters', () => {
    const rows: Row[] = [
      { id: 'a01', name: 'checkout flow', type: 'frontend' },
      { id: 'a02', name: CJK_NAME, type: 'frontend' },
    ];
    const lines = renderTextTable(rows, columns).split('\n');
    expect(lines).toHaveLength(3);
    // Before the display-width fix the CJK row's TYPE column started further
    // right: the name occupies 20 terminal cells but was padded as if 10.
    expect(cellOffset(lines[1]!, 'frontend')).toBeGreaterThan(0);
    expect(cellOffset(lines[1]!, 'frontend')).toBe(cellOffset(lines[2]!, 'frontend'));
    expect(cellOffset(lines[0]!, 'TYPE')).toBe(cellOffset(lines[1]!, 'frontend'));
  });

  it('widens a column to the widest rendered cell even when the declared width undercounts', () => {
    const rows: Row[] = [
      { id: 'a01', name: 'ok', type: 'frontend' },
      { id: 'a02', name: CJK_NAME, type: 'frontend' },
    ];
    // Declared NAME width = max(4, lengths) = 10 — undercounts the 20-cell CJK
    // name. The rendered cells must still align.
    const lines = renderTextTable(rows, columns).split('\n');
    expect(cellOffset(lines[1]!, 'frontend')).toBe(cellOffset(lines[2]!, 'frontend'));
  });

  it('keeps an overlong ASCII cell from misaligning later columns', () => {
    const rows: Row[] = [
      { id: 'a01', name: 'ok', type: 'frontend' },
      { id: 'a02', name: 'a-very-long-checkout-flow-name', type: 'frontend' },
    ];
    const lines = renderTextTable(rows, columns).split('\n');
    expect(typeIndex(lines[1]!)).toBe(typeIndex(lines[2]!));
  });

  it('still pads to the declared width when it exceeds every rendered cell', () => {
    const rows: Row[] = [{ id: 'a01', name: 'ok', type: 'frontend' }];
    const lines = renderTextTable(rows, columns).split('\n');
    // ID width 8 + two-space gutter → NAME starts at column 10; NAME declared
    // width is max(4, 2) = 4, so TYPE starts at 10 + 4 + 2 = 16.
    expect(lines[1]!.indexOf('frontend')).toBe(16);
    expect(lines[0]!.indexOf('TYPE')).toBe(16);
  });

  it('renders an empty row list as just the header', () => {
    const out = renderTextTable([], columns);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('ID');
  });

  it('honors --columns selection and --no-header with CJK rows', () => {
    const rows: Row[] = [
      { id: 'a01', name: 'checkout flow', type: 'frontend' },
      { id: 'a02', name: CJK_NAME, type: 'frontend' },
    ];
    const lines = renderTextTable(rows, columns, { columns: 'type,name', noHeader: true }).split(
      '\n',
    );
    expect(lines).toHaveLength(2);
    // TYPE first: 'type' column index 0 in every row.
    for (const line of lines) expect(line.startsWith('frontend')).toBe(true);
    expect(cellOffset(lines[0]!, 'checkout flow')).toBe(cellOffset(lines[1]!, CJK_NAME));
  });

  it('counts a single emoji as 2 terminal cells', () => {
    expect(terminalWidth('👍')).toBe(2);
  });

  it('counts a ZWJ grapheme cluster (family emoji) as one 2-cell unit', () => {
    // 👨‍👩‍👧 = three Extended_Pictographic joined by ZWJ; the segmenter
    // yields ONE cluster and the emoji pattern sizes it at 2 cells — the ZWJ
    // itself adds nothing.
    expect(terminalWidth('👨‍👩‍👧')).toBe(2);
    expect(terminalWidth('👍👍')).toBe(4);
  });

  it('keeps later columns aligned when a name contains emoji', () => {
    const rows: Row[] = [
      { id: 'a01', name: 'checkout flow', type: 'frontend' },
      { id: 'a02', name: '👍 登录支付', type: 'frontend' },
    ];
    const lines = renderTextTable(rows, columns).split('\n');
    expect(cellOffset(lines[1]!, 'frontend')).toBe(cellOffset(lines[2]!, 'frontend'));
  });
});

describe('measureTextColumns', () => {
  it('raises the declared width to the widest rendered cell in display columns', () => {
    const rows: Row[] = [{ id: 'a01', name: CJK_NAME, type: 'frontend' }];
    // Declared NAME width counts 10 code units; display width is 20.
    expect(measureTextColumns(rows, columns)[1]).toBe(20);
  });

  it('keeps the declared width when every cell fits within it', () => {
    const rows: Row[] = [{ id: 'a01', name: 'ok', type: 'frontend' }];
    expect(measureTextColumns(rows, columns)[0]).toBe(8);
  });

  it('includes the header in the width floor', () => {
    // A narrow declared width must still fit its own header, or the header
    // overflows and the columns after it misalign.
    const narrow: TextTableColumn<Row> = { header: 'DURATION', width: 2, render: () => '1m' };
    expect(measureTextColumns([{ id: 'a01', name: 'ok', type: 'frontend' }], [narrow])[0]).toBe(8);
  });
});

describe('formatTextTableRow', () => {
  it('pads by display width, so a full-width value fills its cell', () => {
    // CJK_NAME is 20 cells; a width of 20 must produce no trailing pad.
    const line = formatTextTableRow([CJK_NAME, 'x'], [20, 1]);
    expect(line.endsWith('x')).toBe(true);
    expect(line.startsWith(CJK_NAME)).toBe(true);
    // 20-cell value in a 15-wide cell overflows without padding (unchanged).
    expect(formatTextTableRow([CJK_NAME, 'x'], [15, 1])).toBe(`${CJK_NAME}  x`);
  });
});
