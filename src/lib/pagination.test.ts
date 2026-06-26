import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import { paginate, validatePaginationFlags, type FetchPage, type Page } from './pagination.js';

function makePages<T>(pages: Page<T>[]): {
  fetchPage: FetchPage<T>;
  calls: Array<{ pageSize: number; cursor: string | undefined }>;
} {
  const calls: Array<{ pageSize: number; cursor: string | undefined }> = [];
  let i = 0;
  const fetchPage: FetchPage<T> = async args => {
    calls.push(args);
    const page = pages[Math.min(i, pages.length - 1)]!;
    i += 1;
    return page;
  };
  return { fetchPage, calls };
}

describe('validatePaginationFlags', () => {
  it('accepts an empty flag object', () => {
    expect(validatePaginationFlags({})).toEqual({});
  });

  it('rejects pageSize=0', () => {
    expect(() => validatePaginationFlags({ pageSize: 0 })).toThrow(ApiError);
  });

  it('rejects pageSize=-1', () => {
    expect(() => validatePaginationFlags({ pageSize: -1 })).toThrow(ApiError);
  });

  it('rejects pageSize > 100 with VALIDATION_ERROR exit 5 (Fix 7 — B-E2E-01 wave)', () => {
    // Previously silently clamped; now rejected so callers get fast feedback.
    expect(() => validatePaginationFlags({ pageSize: 101 })).toThrow(ApiError);
  });

  it('rejects pageSize=10000 with VALIDATION_ERROR exit 5', () => {
    expect(() => validatePaginationFlags({ pageSize: 10_000 })).toThrow(ApiError);
  });

  it('rejects pageSize=NaN', () => {
    expect(() => validatePaginationFlags({ pageSize: Number.NaN })).toThrow(ApiError);
  });

  it('rejects fractional pageSize values', () => {
    expect(() => validatePaginationFlags({ pageSize: 1.5 })).toThrow(ApiError);
  });

  it('rejects maxItems=0', () => {
    expect(() => validatePaginationFlags({ maxItems: 0 })).toThrow(ApiError);
  });

  it('rejects fractional maxItems values', () => {
    expect(() => validatePaginationFlags({ maxItems: 2.5 })).toThrow(ApiError);
  });

  it('accepts pageSize=100 (the hard cap)', () => {
    expect(() => validatePaginationFlags({ pageSize: 100 })).not.toThrow();
  });
});

describe('paginate', () => {
  it('auto-follows nextToken to the end and concatenates items', async () => {
    const { fetchPage, calls } = makePages([
      { items: [1, 2], nextToken: 'a' },
      { items: [3, 4], nextToken: 'b' },
      { items: [5], nextToken: null },
    ]);

    const page = await paginate(fetchPage);
    expect(page.items).toEqual([1, 2, 3, 4, 5]);
    expect(page.nextToken).toBeNull();
    expect(calls).toHaveLength(3);
    expect(calls[0]!.cursor).toBeUndefined();
    expect(calls[1]!.cursor).toBe('a');
    expect(calls[2]!.cursor).toBe('b');
  });

  it('honors maxItems and stops mid-page when the cap is hit', async () => {
    const { fetchPage } = makePages([
      { items: [1, 2, 3], nextToken: 'cursor-1' },
      { items: [4, 5, 6], nextToken: 'cursor-2' },
    ]);

    const page = await paginate(fetchPage, { maxItems: 4 });
    expect(page.items).toEqual([1, 2, 3, 4]);
    // nextToken surfaces the *server's* last response so the caller
    // can resume.
    expect(page.nextToken).toBe('cursor-2');
  });

  it('passes startingToken on the first call', async () => {
    const { fetchPage, calls } = makePages([{ items: [1], nextToken: null }]);
    await paginate(fetchPage, { startingToken: 'resume' });
    expect(calls[0]!.cursor).toBe('resume');
  });

  it('shrinks the per-call pageSize when remaining < pageSize', async () => {
    const { fetchPage, calls } = makePages([
      { items: [1], nextToken: 'cursor-x' },
      { items: [2], nextToken: 'cursor-y' },
    ]);

    await paginate(fetchPage, { pageSize: 25, maxItems: 2 });
    // First call asks for min(25, 2) = 2.
    expect(calls[0]!.pageSize).toBe(2);
    // Second call asks for min(25, 1) = 1 — only 1 slot remains.
    expect(calls[1]!.pageSize).toBe(1);
  });

  it('returns nextToken=null when the server signals end and items < maxItems', async () => {
    const { fetchPage } = makePages([{ items: [1, 2], nextToken: null }]);
    const page = await paginate(fetchPage, { maxItems: 100 });
    expect(page.items).toEqual([1, 2]);
    expect(page.nextToken).toBeNull();
  });

  it('rejects flag combinations at validation time before fetching', async () => {
    const { fetchPage, calls } = makePages([{ items: [1], nextToken: null }]);
    await expect(paginate(fetchPage, { pageSize: 0 })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);
  });
});
