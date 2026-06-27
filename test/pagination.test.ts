import { describe, it, expect, vi } from 'vitest';
import { paginate, type Page, type FetchPage } from '../src/lib/pagination.js';

describe('paginate', () => {
  it('collects all items across pages until nextToken is null', async () => {
    const pages: Page<string>[] = [
      { items: ['a', 'b'], nextToken: 'cursor1' },
      { items: ['c'], nextToken: null },
    ];
    let callIndex = 0;
    const fetchPage: FetchPage<string> = async () => pages[callIndex++]!;

    const result = await paginate(fetchPage);

    expect(result.items).toEqual(['a', 'b', 'c']);
    expect(result.nextToken).toBeNull();
  });

  it('breaks out of loop when API returns empty items with non-null nextToken', async () => {
    // This is the bug from issue #35: API returns { items: [], nextToken: 'cursor' }
    // Without the fix, paginate() would loop forever requesting the same empty page.
    const fetchPage: FetchPage<string> = vi.fn(async (): Promise<Page<string>> => ({
      items: [],
      nextToken: 'cursor',
    }));

    const result = await paginate(fetchPage);

    expect(result.items).toEqual([]);
    // nextToken should reflect what the server returned, not null
    expect(result.nextToken).toBe('cursor');
    // Must have only fetched once — no infinite loop
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('respects maxItems cap', async () => {
    const pages: Page<string>[] = [
      { items: ['a', 'b', 'c'], nextToken: 'cursor1' },
      { items: ['d', 'e'], nextToken: null },
    ];
    let callIndex = 0;
    const fetchPage: FetchPage<string> = async () => pages[callIndex++]!;

    const result = await paginate(fetchPage, { maxItems: 2 });

    expect(result.items).toEqual(['a', 'b']);
  });

  it('handles single page with null nextToken', async () => {
    const fetchPage: FetchPage<string> = async () => ({
      items: ['x'],
      nextToken: null,
    });

    const result = await paginate(fetchPage);

    expect(result.items).toEqual(['x']);
    expect(result.nextToken).toBeNull();
  });

  it('handles consecutive empty pages then data', async () => {
    // Edge case: first page empty (with token), second page has data
    const pages: Page<string>[] = [
      { items: [], nextToken: 'cursor1' },
      { items: ['a'], nextToken: null },
    ];
    let callIndex = 0;
    const fetchPage: FetchPage<string> = vi.fn(async (): Promise<Page<string>> => pages[callIndex++]!);

    const result = await paginate(fetchPage);

    // With the fix, the first empty page breaks the loop immediately.
    // This is correct behavior — if the first page is empty, there's
    // no reason to keep fetching.
    expect(result.items).toEqual([]);
    expect(result.nextToken).toBe('cursor1');
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
