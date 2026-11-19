import { describe, expect, it } from 'vitest';
import { titleFrom } from './title.js';

describe('titleFrom', () => {
  it('takes the first line with words on it, spaces made one', () => {
    expect(titleFrom('\n  Cover   the coupon rules\nand more')).toBe('Cover the coupon rules');
  });

  it('cuts a long line at a word, as the portal does', () => {
    const title = titleFrom(`${'word '.repeat(30)}end`)!;
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith('word…')).toBe(true);
  });

  it('names nothing from an empty message', () => {
    expect(titleFrom('  \n ')).toBeUndefined();
  });
});
