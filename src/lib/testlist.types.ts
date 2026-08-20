/**
 * Wire shapes for the `/api/cli/v1/testlist/*` surface (CRUD).
 *
 * `testId` on a case IS the test's logical id (`test_case.key`) — the same id
 * `test list` / `test get` return and `test run` accepts, so a case can be added
 * to a list with no translation.
 */

import type { RunConflict } from './conflict-reason.js';

export interface CliProjectEnvironment {
  projectId: string;
  environmentName: string;
}

/** A test-list row (no cases) — `testlist list`. */
export interface CliTestList {
  id: string;
  name: string;
  orgId: string;
  caseCount: number;
  projectEnvironments: CliProjectEnvironment[];
  lastExecutionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One case inside a list — `testlist get`. */
export interface CliTestListCase {
  /** The test's logical id (== `test_case.key`). */
  testId: string;
  type: 'frontend' | 'backend';
  projectId: string;
  projectName: string;
  title: string | null;
  category: string | null;
  priority: string | null;
  modified: string | null;
  status: string | null;
}

/** Full detail incl. cases + stats — `testlist get` / after a mutation. */
export interface CliTestListDetail extends CliTestList {
  cases: CliTestListCase[];
  stats: { total: number; passed: number; failed: number; blocked: number; running: number };
  lastExecutionCreated: string | null;
}

export interface CliTestListListResponse {
  items: CliTestList[];
}

export interface CliDeleteTestListResponse {
  listId: string;
}

/** One dispatched run from `testlist run` — `runId` polls via `GET /runs/{runId}`. */
export interface CliTestListRunAccepted {
  testId: string;
  runId: string;
  enqueuedAt: string;
}

/**
 * `testlist run` result. Mirrors the batch-run-fresh envelope so `--wait` reuses
 * the same poll/summary tail. `conflicts[]` carry the in-flight `currentRunId`
 * (poll it instead of retrying). `deferred[]` carries the cases the per-key
 * run-rate budget could not admit this call (retry after ~60s). `notFound[]` is
 * present on a PARTIAL `--case` miss — ids not in this list, skipped (a FULL miss
 * is a 404). `reason` is set only when nothing dispatched (empty list).
 */
export interface CliTestListRunResponse {
  accepted: CliTestListRunAccepted[];
  conflicts: RunConflict[];
  deferred: Array<{ testId: string }>;
  notFound?: string[];
  reason?: 'no_matching_cases' | 'empty_list';
}
