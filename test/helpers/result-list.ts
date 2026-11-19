/**
 * `GET /results` as the server answers it, for specs, stubs and the mock
 * backend that script it.
 */
import {
  ALL_RESULT_STATUSES,
  type ResultLine,
  type ResultList,
} from '../../src/lib/result/types.js';

/** Every status the server knows, as the wire spells it. */
export const RESULT_STATUSES: readonly string[] = ALL_RESULT_STATUSES.map(status =>
  status.toUpperCase(),
);

/**
 * The statuses a `GET /results` request asks for, read as the server reads
 * `status`: repeated or comma-separated, any case, and every status but
 * cancelled when it names none. `undefined` when it names a status the server
 * does not know, which the server refuses with a 400.
 */
export function requestedResultStatuses(query: URLSearchParams): string[] | undefined {
  const named = query
    .getAll('status')
    .flatMap(part => part.split(','))
    .map(part => part.trim().toUpperCase())
    .filter(Boolean);
  if (named.some(status => !RESULT_STATUSES.includes(status))) return undefined;
  return named.length > 0 ? named : RESULT_STATUSES.filter(status => status !== 'CANCELLED');
}

/** One listed result. Fields a test does not name are those of a running result. */
export function resultLine(
  line: Pick<ResultLine, 'resultId' | 'runId'> & Partial<ResultLine>,
): ResultLine {
  return {
    caseKey: null,
    title: `Test ${line.caseKey ?? line.resultId}`,
    testStatus: 'RUNNING',
    processStatus: 'Executing',
    error: null,
    blockedReason: null,
    environmentName: 'prod',
    created: '2026-11-01T00:00:00.000Z',
    ...line,
  };
}

/**
 * The lines a `GET /results` request gets back: those whose status it asks
 * for. A request the server would refuse (an unknown status) throws, so a spec
 * whose command sends one fails on it.
 */
export function resultListAnswer(lines: readonly ResultLine[], query: URLSearchParams): ResultList {
  const statuses = requestedResultStatuses(query);
  if (statuses === undefined) {
    throw new Error(`GET /results named a status the server refuses: ${query.getAll('status')}`);
  }
  return { results: lines.filter(line => statuses.includes(line.testStatus)) };
}
