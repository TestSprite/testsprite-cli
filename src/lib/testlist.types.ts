/**
 * Wire shapes for the `/api/cli/v1/testlist/*` surface (CRUD).
 *
 * `testId` on a case IS the test's logical id (`test_case.key`) — the same id
 * `test list` / `test get` return and `run` accepts, so a case can be added
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
  lastRunId: string | null;
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
  lastRunCreated: string | null;
}

export interface CliTestListListResponse {
  items: CliTestList[];
}

export interface CliDeleteTestListResponse {
  listId: string;
}

/** One dispatched result from `run --testlist`; wait by runId through GET /results?run=. */
export interface CliTestListRunAccepted {
  testId: string;
  /** The result id (wire name). Printed as `resultId`. */
  resultId: string;
  /** The launch this result belongs to (wire name); required for whole-run waiting. */
  runId?: string;
  enqueuedAt: string;
  testTitle?: string | null;
  dashboardUrl?: string | null;
  executionUrl?: string | null;
}

/**
 * `run --testlist` result. Mirrors the batch-run-fresh envelope so `--wait` reuses
 * the execution wait and summary tail. `conflicts[]` carry the in-flight `currentResultId`
 * (inspect it instead of retrying). `deferred[]` carries the cases the per-key
 * run-rate budget could not admit this call (retry after ~60s). `notFound[]` is
 * present on a PARTIAL `--case` miss — ids not in this list, skipped (a FULL miss
 * is a 404). `reason` is set only when nothing dispatched (empty list).
 */
export interface CliTestListRunResponse {
  tunnelClientId?: string;
  /** Maximum effective server concurrency across frontend project executions. */
  maxConcurrency?: number;
  accepted: CliTestListRunAccepted[];
  conflicts: RunConflict[];
  deferred: Array<{ testId: string }>;
  notFound?: string[];
  reason?: 'no_matching_cases' | 'empty_list';
}
