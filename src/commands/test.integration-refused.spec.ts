import { describe, expect, it } from 'vitest';
import { renderTestListText, type CliTest } from './test.js';

const TEST_ROW: CliTest = {
  id: 'tc1',
  projectId: 'p1',
  title: 'Plain',
  type: 'backend',
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T00:00:00Z',
};

describe('test list TYPE column', () => {
  it('marks integration tests and leaves other rows untouched', () => {
    const text = renderTestListText({
      items: [TEST_ROW, { ...TEST_ROW, id: 'tc2', title: 'Assembled', isIntegration: true }],
      nextToken: null,
    });
    const lines = text.split('\n');
    expect(lines[0]).toContain('TYPE');
    expect(lines.find(l => l.includes('Assembled'))).toContain('backend/int');
    expect(lines.find(l => l.includes('Plain'))).not.toContain('/int');
    // Columns after TYPE stay aligned under their header.
    const col = (l: string, word: string) => l.indexOf(word);
    expect(col(lines[0]!, 'FROM')).toBe(
      col(
        lines.find(l => l.includes('Assembled'))!,
        'cli',
      ),
    );
  });

  it('renders old-backend rows (no isIntegration) as before', () => {
    expect(renderTestListText({ items: [TEST_ROW], nextToken: null })).not.toContain('/int');
  });
});
