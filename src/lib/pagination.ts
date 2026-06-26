import type { HttpClient } from './http.js';
import { localValidationError } from './errors.js';

/**
 * Page shape returned by every list endpoint per
 * the CLI OpenAPI spec §components.schemas.ProjectList /
 * TestList / TestStepList.
 */
export interface Page<T> {
  items: T[];
  nextToken: string | null;
}

export interface PaginationFlags {
  /** Service page-size hint. Per OpenAPI: 1–100, default 25. */
  pageSize?: number;
  /** Opaque cursor from a previous response. */
  startingToken?: string;
  /** Client-side cap on total items returned across pages. */
  maxItems?: number;
}

const HARD_PAGE_SIZE_CAP = 100;
const DEFAULT_PAGE_SIZE = 25;

/**
 * Validates and normalizes pagination flags. Per the CLI OpenAPI spec
 * §components.parameters.PageSize the hard cap is 100. Values above the
 * cap are now rejected with exit 5 rather than silently clamped, giving
 * callers fast feedback that their flag value is out of range. Fractional,
 * sub-1, and NaN values also throw. `maxItems` is validated but not capped
 * (it is a client-side cursor, not a server parameter).
 *
 * NOTE: `runResultHistory` previously did its own silent clamp via
 * `Math.min(Math.max(1, n), 100)` — that was unified to this path by the
 * same fix wave (B-E2E-01 fix 7).
 */
export function validatePaginationFlags(flags: PaginationFlags): PaginationFlags {
  const out: PaginationFlags = { ...flags };
  if (out.pageSize !== undefined) {
    if (!Number.isFinite(out.pageSize) || !Number.isInteger(out.pageSize) || out.pageSize < 1) {
      throw localValidationError(
        'page-size',
        `must be a positive integer between 1 and ${HARD_PAGE_SIZE_CAP}`,
      );
    }
    if (out.pageSize > HARD_PAGE_SIZE_CAP) {
      throw localValidationError(
        'page-size',
        `must be between 1 and ${HARD_PAGE_SIZE_CAP} (got ${out.pageSize})`,
      );
    }
  }
  if (out.maxItems !== undefined) {
    if (!Number.isFinite(out.maxItems) || !Number.isInteger(out.maxItems) || out.maxItems < 1) {
      throw localValidationError('maxItems', 'must be a positive integer');
    }
  }
  return out;
}

export interface FetchPageArgs {
  pageSize: number;
  cursor: string | undefined;
}

export type FetchPage<T> = (args: FetchPageArgs) => Promise<Page<T>>;

/**
 * Calls `fetchPage` repeatedly, honoring `--max-items` and
 * `--starting-token`. Behavior matches AWS CLI auto-paging:
 *
 *   - If neither `pageSize` nor `maxItems` is set, follows pages until
 *     `nextToken` is null. Default service page size (25) is used.
 *   - If `pageSize` is set, uses it as the per-call hint.
 *   - If `maxItems` is set, stops once the total exceeds it.
 *   - The returned `nextToken` is whatever the server said on the
 *     last page consumed — not necessarily `null`. Callers that paged
 *     out via `--max-items` see a non-null token they can pass back
 *     in `--starting-token` to resume.
 */
export async function paginate<T>(
  fetchPage: FetchPage<T>,
  flags: PaginationFlags = {},
): Promise<Page<T>> {
  validatePaginationFlags(flags);

  const pageSize = flags.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxItems = flags.maxItems;

  const items: T[] = [];
  let cursor: string | undefined = flags.startingToken;
  let lastNextToken: string | null = null;

  while (true) {
    const remaining = maxItems !== undefined ? maxItems - items.length : Infinity;
    if (remaining <= 0) break;

    const callPageSize = Number.isFinite(remaining) ? Math.min(pageSize, remaining) : pageSize;

    const page = await fetchPage({ pageSize: callPageSize, cursor });
    lastNextToken = page.nextToken;

    for (const item of page.items) {
      if (maxItems !== undefined && items.length >= maxItems) break;
      items.push(item);
    }

    if (page.nextToken === null) break;
    cursor = page.nextToken;
  }

  return { items, nextToken: lastNextToken };
}

/**
 * Drop-in helper for commands that take a single page and surface
 * the cursor verbatim (no auto-follow). Used when the caller passed
 * an explicit `--page-size` and didn't ask for `--max-items`.
 */
export async function fetchSinglePage<T>(
  client: HttpClient,
  path: string,
  pageSize: number,
  cursor: string | undefined,
  extraQuery: Record<string, string | number | boolean | undefined> = {},
): Promise<Page<T>> {
  return client.get<Page<T>>(path, {
    query: { ...extraQuery, pageSize, cursor },
  });
}
