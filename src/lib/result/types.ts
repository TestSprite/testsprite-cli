/**
 * Wire shapes of the two result routes, `GET /results` and
 * `GET /results/{resultId}`. A run is one launch; a result is one test's part
 * of it, so `runId` here names the launch and `resultId` the test's result.
 */

/**
 * Every status the `status` filter of `GET /results` takes. The server leaves
 * cancelled results out unless `status` names them, so a caller that needs
 * every result of a run passes this whole list.
 */
export const ALL_RESULT_STATUSES = ['passed', 'failed', 'running', 'blocked', 'cancelled'] as const;

/**
 * Whether a result is still running. Every other status is final: it passed,
 * failed, was blocked or was cancelled. The wire spells statuses in upper case.
 */
export function isResultRunning(testStatus: string): boolean {
  return testStatus.toLowerCase() === 'running';
}

/** `GET /results?run=<runId>` or `?test=<testId>`. */
export interface ResultList {
  /**
   * A run's listing only: the run itself. Absent from an older backend; null
   * when the server sent one without a readable `runId` and `status`.
   */
  run?: ResultRun | null;
  /** Newest first. */
  results: ResultLine[];
  /** A test's history only: how many results the plan's history window holds back. */
  hiddenRunCount?: number;
  /** A test's history only. */
  retentionDays?: number | null;
}

/**
 * The run a `GET /results?run=<runId>` listing is of. Only `runId` and
 * `status` are required; every other field is null when the server left it
 * out or sent something this CLI cannot read.
 */
export interface ResultRun {
  runId: string;
  /**
   * `running` or `finished`. The server says `finished` once the run has
   * nothing left to add or run, so a backend run's integration results are in
   * the listing by then. Kept open: a value this CLI does not know is not
   * `finished`.
   */
  status: 'running' | 'finished' | (string & {});
  projectId: string | null;
  /** The run was cancelled. */
  cancelled: boolean | null;
  /** ISO timestamp. */
  created: string | null;
  /** ISO timestamp. */
  modified: string | null;
  targetUrl: string | null;
  /** Server-built; null means no link. */
  dashboardUrl: string | null;
}

export interface ResultLine {
  resultId: string;
  runId: string | null;
  caseKey: string | null;
  title: string;
  /** Upper case on the wire: `PASSED`, `FAILED`, `RUNNING`, `BLOCKED`, `CANCELLED`. */
  testStatus: string;
  processStatus: string | null;
  error: string | null;
  blockedReason: string | null;
  environmentName: string | null;
  /** ISO timestamp. */
  created: string;
  /** ISO timestamp of the result's last change. Absent from an older backend. */
  modified?: string;
}

/** `GET /results/{resultId}`. */
export interface ResultDetail {
  resultId: string;
  runId: string | null;
  caseKey: string | null;
  caseHash: string | null;
  title: string;
  type: string;
  testStatus: string;
  processStatus: string | null;
  processErrorMessage: string | null;
  error: string | null;
  cause: string | null;
  fix: string | null;
  blockedReason: string | null;
  /** A backend test's Python traceback; null for a frontend test, absent from an older backend. */
  trace?: string | null;
  /** A backend test's captured output; null for a frontend test, absent from an older backend. */
  apiOutput?: string | null;
  videoUrl: string | null;
  envId: string | null;
  created: string;
  modified: string;
  /** The first step, in numeric order, whose status is `failed`. */
  failedStep: ResultStep | null;
  /** In numeric order. */
  steps: ResultStep[];
  /** The sign-in run behind a result blocked at sign-in; null for every other result. */
  signIn: ResultSignIn | null;
}

export interface ResultStep {
  stepIndex: string | null;
  type: string | null;
  action: string | null;
  description: string | null;
  status: 'passed' | 'failed' | null;
  selector: string | null;
  url: string | null;
  healed: boolean;
  screenshotSignedUrl: string | null;
  htmlSignedUrl: string | null;
}

export interface ResultSignIn {
  id: string;
  status: string | null;
  videoUrl: string | null;
  finalUrl: string | null;
  stepCount: number | null;
  error: string | null;
  steps: ResultStep[];
}
