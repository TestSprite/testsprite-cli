import type { HttpClient } from '../http.js';
import { RESULT_DETAIL_SCHEMA, RESULT_LIST_SCHEMA } from '../response-schemas.js';
import type { ResultDetail, ResultList } from './types.js';

export interface ResultApi {
  /**
   * The results of one run. Without `statuses` the server returns every result
   * but the cancelled ones; pass `ALL_RESULT_STATUSES` to get those too.
   * `retry: false` makes one attempt, with no retry and no `Retry-After` wait.
   */
  listByRun(
    runId: string,
    statuses?: readonly string[],
    opts?: { signal?: AbortSignal; retry?: boolean },
  ): Promise<ResultList>;
  /** One test's results across runs, newest first; the server returns 20 unless `limit` says otherwise. */
  listByTest(
    testId: string,
    opts?: { statuses?: readonly string[]; env?: string; limit?: number; signal?: AbortSignal },
  ): Promise<ResultList>;
  get(resultId: string, opts?: { signal?: AbortSignal }): Promise<ResultDetail>;
}

/** The `status` filter as the server reads it; an empty list filters nothing. */
const statusParam = (statuses?: readonly string[]): string | undefined =>
  statuses?.length ? statuses.join(',') : undefined;

export function resultApi(client: HttpClient): ResultApi {
  return {
    listByRun: (runId, statuses, opts = {}) =>
      client.get('/results', {
        query: { run: runId, status: statusParam(statuses) },
        schema: RESULT_LIST_SCHEMA,
        signal: opts.signal,
        retry: opts.retry,
      }),

    listByTest: (testId, opts = {}) =>
      client.get('/results', {
        query: {
          test: testId,
          status: statusParam(opts.statuses),
          environment: opts.env,
          limit: opts.limit,
        },
        schema: RESULT_LIST_SCHEMA,
        signal: opts.signal,
      }),

    get: (resultId, opts = {}) =>
      client.get(`/results/${encodeURIComponent(resultId)}`, {
        schema: RESULT_DETAIL_SCHEMA,
        signal: opts.signal,
      }),
  };
}
