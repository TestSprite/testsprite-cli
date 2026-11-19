import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionReport } from './runs.types.js';
import { describeConflict, type RunConflict } from './conflict-reason.js';
import { launchIds } from './run-render.js';
import { terminalSafe } from './terminal-text.js';

/**
 * CI-native output layer for the run path (issue #99, reshaped from
 * the withdrawn top-level `ci` command per the #264 review). Covers both a
 * single `run <test-id> --wait` and the `run --project --wait` batch.
 *
 * A `--wait` run presents its result in the formats CI consumes:
 *   (a) a stable machine summary `{total, passed, failed, blocked?, skipped, timedOut,
 *       results[]}` written to `--summary-file <path>` when requested,
 *   (b) a Markdown results table appended to `$GITHUB_STEP_SUMMARY` when
 *       running under GitHub Actions,
 *   (c) one workflow-command line per non-passed run so it annotates the PR
 *       checks tab — `::error::` for a dispatched run that failed or timed
 *       out, `::warning::` for a test that never dispatched.
 * Activation: `GITHUB_ACTIONS=true` in the environment, or the explicit
 * `--gh-output` flag (which forces the annotations even off-Actions, so the
 * behavior is previewable locally). All writes are best-effort: a broken
 * summary file must never mask the batch gate's exit code.
 */

export interface CiRunRow {
  /** Absent for an execution diagnostic or a result without a case key. */
  testId?: string;
  /** Human title for the Test column; falls back to `testId` when absent. */
  title?: string;
  /**
   * The result id (wire name), written out as `resultId`. On a row that never
   * dispatched because the test was already running, it is that run's result.
   */
  resultId?: string;
  /**
   * The launch the result belongs to (wire name), written out as `runId`.
   * Absent on an older backend.
   */
  runId?: string;
  status: string;
  /** Test-case page link — anchors the Test column title. */
  dashboardUrl?: string;
  /** This result's own page link — anchors the Result column. */
  executionUrl?: string;
  error?: string;
}

export interface CiSummary {
  total: number;
  passed: number;
  failed: number;
  /** Disjoint from failed. Absent when no test was blocked. */
  blocked?: number;
  cancelled?: number;
  /** Result-level read errors or unknown verdicts. */
  errors?: number;
  /**
   * Requested tests that never dispatched (deferred / conflict / not_found /
   * skipped / no_tests rows). Kept OUT of `failed`: `failed` claiming
   * a test failed while the exit code says otherwise is the artifacts-disagree
   * bug this field fixes. Non-dispatch still gates the exit where it should
   * (deferred → 7, all-conflict → 6, not-found → 4, zero-dispatch → 5).
   */
  skipped: number;
  timedOut: number;
  /** Present when a wait ends with dispatched tests still running. */
  running?: number;
  /**
   * One row per requested test. Not `runs`: in what the CLI prints, `runs[]`
   * is the launches, each with its results.
   */
  results: CiRunRow[];
  /**
   * The server's execution report (the GitHub App comment content) when the
   * backend could provide one for this batch: absent, never null, on an older
   * backend or when no report arrived in time.
   */
  executionReport?: ExecutionReport;
  /** Execution-level failures that cannot be inferred from individual result verdicts. */
  runFailures?: Array<{
    runId: string;
    status: 'cancelled' | 'error' | 'timeout';
    message: string;
  }>;
}

/**
 * Row statuses that mean "this test never ran" as opposed to "this run did not
 * pass". They count as `skipped` in the summary (not `failed`) and annotate as
 * `::warning::` (not `::error::`) so every CI surface tells the same story as
 * the exit code.
 */
const NON_DISPATCHED_STATUSES: ReadonlySet<string> = new Set([
  'deferred',
  'conflict',
  'not_found',
  'skipped',
  'no_tests',
]);

export function isNonDispatchedStatus(status: string): boolean {
  return NON_DISPATCHED_STATUSES.has(status);
}

/**
 * Reduce a non-dispatched bucket (`deferred` / `conflicts` / `notFound`) into
 * CI rows. Items are either bare testId strings (`notFound`) or
 * `{ testId, currentResultId?, currentRunId? }` objects; both shapes are
 * handled. `note` becomes the row's error text so the annotation explains why
 * the item did not run.
 */
function bucketRows(
  bucket: unknown,
  status: string,
  note: string | ((item: unknown) => string),
): CiRunRow[] {
  if (!Array.isArray(bucket)) return [];
  return bucket.map(item => {
    const rec =
      item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
    const testId =
      typeof item === 'string' ? item : typeof rec?.testId === 'string' ? rec.testId : '';
    const currentResultId =
      typeof rec?.resultId === 'string'
        ? rec.resultId
        : typeof rec?.currentResultId === 'string'
          ? rec.currentResultId
          : undefined;
    const currentRunId =
      typeof rec?.runId === 'string'
        ? rec.runId
        : typeof rec?.currentRunId === 'string'
          ? rec.currentRunId
          : undefined;
    return {
      testId,
      status,
      ...(currentResultId ? { resultId: currentResultId } : {}),
      ...(currentRunId ? { runId: currentRunId } : {}),
      error: typeof note === 'string' ? note : note(item),
    };
  });
}

/**
 * Reduce the batch command's JSON payload into the CI summary. The parse is
 * defensive: it reads the same `accepted[]` rows the automation contract
 * documents, and anything unparseable (dry-run envelope, partial output
 * after a timeout) reduces to an empty run list rather than a crash.
 *
 * Non-dispatched work (`deferred` / `conflicts` / `notFound`) is folded in as
 * non-passed rows so a partial batch like `1 accepted passed + 1 deferred`
 * cannot read as "1/1 passed" with no annotation — but it counts as `skipped`,
 * never `failed`: whether non-dispatch fails the job is the exit-code
 * gates' call, and a `failed` count the gates disagree with is exactly the
 * artifacts-contradict-the-exit bug.
 *
 * `foldSkippedBuckets` (the `ci run` contract) keeps a `not_found` conflict's
 * own status so the `ci run` gate can exit 4 for it. Default off — for
 * `run --project` it stays a conflict row, and changing that default would
 * silently change its artifacts.
 */
export function summarizeAcceptedPayload(
  capturedJson: string,
  opts: { notFoundNote?: string; foldSkippedBuckets?: boolean } = {},
): CiSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(capturedJson);
  } catch {
    // Not JSON at all (dry-run banner path or truncated output): no rows.
    parsed = undefined;
  }
  // `JSON.parse('null')` and non-object payloads are valid JSON but carry no
  // batch envelope — treat them like unparseable input instead of crashing.
  const payload: {
    accepted?: unknown;
    results?: unknown;
    deferred?: unknown;
    conflicts?: unknown;
    notFound?: unknown;
    skipped?: unknown;
  } = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const sourceRows = payload.results ?? payload.accepted;
  const acceptedRows: CiRunRow[] = Array.isArray(sourceRows)
    ? sourceRows
        .filter(
          (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object',
        )
        .map(row => {
          const errorMessage =
            row.error !== null && typeof row.error === 'object'
              ? (row.error as { message?: unknown }).message
              : undefined;
          return {
            testId: String(row.testId ?? ''),
            ...(typeof row.testTitle === 'string' ? { title: row.testTitle } : {}),
            ...(typeof row.resultId === 'string' ? { resultId: row.resultId } : {}),
            ...(typeof row.runId === 'string' ? { runId: row.runId } : {}),
            status: String(row.status ?? 'unknown'),
            ...(typeof row.dashboardUrl === 'string' ? { dashboardUrl: row.dashboardUrl } : {}),
            ...(typeof row.executionUrl === 'string' ? { executionUrl: row.executionUrl } : {}),
            ...(typeof errorMessage === 'string' ? { error: errorMessage } : {}),
          };
        })
    : [];
  return summarizeRunRows(acceptedRows, payload, opts);
}

/** Summarize the known results together with members the server did not dispatch. */
export function summarizeRunRows(
  results: CiRunRow[],
  payload: { conflicts?: unknown; skipped?: unknown; deferred?: unknown; notFound?: unknown } = {},
  opts: { notFoundNote?: string; foldSkippedBuckets?: boolean } = {},
): CiSummary {
  const notFoundConflicts = new Set(
    Array.isArray(payload.conflicts)
      ? payload.conflicts
          .filter(c => (c as Partial<RunConflict> | null)?.reason === 'not_found')
          .map(c => String((c as RunConflict).testId))
      : [],
  );
  const rows: CiRunRow[] = [
    ...results,
    ...bucketRows(payload.skipped, 'skipped', item =>
      typeof (item as { reason?: unknown })?.reason === 'string'
        ? (item as { reason: string }).reason
        : 'not dispatched',
    ),
    ...bucketRows(payload.deferred, 'deferred', 'rate-deferred (not dispatched)'),
    // One note per conflict, from its reason (HEAD); under `foldSkippedBuckets`
    // a `not_found` conflict keeps its own status so the `ci run` gate can
    // exit 4 for it instead of reading it as a transient conflict.
    ...bucketRows(payload.conflicts, 'conflict', item => {
      const conflict = item as Partial<RunConflict> | null;
      return conflict && typeof conflict.testId === 'string' && conflict.reason
        ? `${describeConflict(conflict as RunConflict)} (not dispatched)`
        : 'already in flight (not dispatched)';
    }).map(row =>
      opts.foldSkippedBuckets === true &&
      row.testId !== undefined &&
      notFoundConflicts.has(row.testId)
        ? { ...row, status: 'not_found' }
        : row,
    ),
    // `run --testlist` passes its own note — a not-found `--case` id is one that
    // is not a member of the list — so the annotation/artifact don't state the
    // wrong reason on the surface this whole layer exists to serve.
    ...bucketRows(
      payload.notFound,
      'not_found',
      opts.notFoundNote ?? 'test not found (not dispatched)',
    ),
  ];
  return summarizeRows(rows);
}

function summarizeRows(rows: CiRunRow[]): CiSummary {
  const running = rows.filter(row => row.status === 'running').length;
  const passed = rows.filter(row => row.status === 'passed').length;
  const timedOut = rows.filter(row => row.status === 'timeout').length;
  const skipped = rows.filter(row => isNonDispatchedStatus(row.status)).length;
  const blocked = rows.filter(row => row.status === 'blocked').length;
  const failed = rows.filter(row => row.status === 'failed').length;
  const cancelled = rows.filter(row => row.status === 'cancelled').length;
  const errors = rows.length - passed - failed - blocked - cancelled - timedOut - skipped - running;
  return {
    total: rows.length,
    passed,
    failed,
    ...(blocked ? { blocked } : {}),
    ...(cancelled ? { cancelled } : {}),
    ...(errors ? { errors } : {}),
    skipped,
    timedOut,
    ...(running ? { running } : {}),
    results: rows,
  };
}

/**
 * Reduce a single `run <test-id> --wait` result into the same CI summary
 * shape as the batch path, so `--gh-output` / `--summary-file` behave
 * identically for a one-test CI job. Unlike the batch envelope, a single
 * RunResponse carries `error` as a raw string (not `{ message }`) and
 * `dashboardUrl` as `string | null`; both are normalized here.
 */
export function summarizeSingleRun(run: {
  testId?: string;
  testTitle?: string | null;
  resultId?: string;
  runId?: string;
  status?: string;
  dashboardUrl?: string | null;
  executionUrl?: string | null;
  error?: string | null;
}): CiSummary {
  const row: CiRunRow = {
    testId: String(run.testId ?? ''),
    ...(typeof run.testTitle === 'string' ? { title: run.testTitle } : {}),
    ...(typeof run.resultId === 'string' ? { resultId: run.resultId } : {}),
    ...(typeof run.runId === 'string' ? { runId: run.runId } : {}),
    status: String(run.status ?? 'unknown'),
    ...(typeof run.dashboardUrl === 'string' ? { dashboardUrl: run.dashboardUrl } : {}),
    ...(typeof run.executionUrl === 'string' ? { executionUrl: run.executionUrl } : {}),
    ...(typeof run.error === 'string' && run.error.length > 0 ? { error: run.error } : {}),
  };
  return summarizeRows([row]);
}

/**
 * Escape a value for a Markdown table cell. A raw `|` would break the column
 * layout and a CR/LF would inject extra Markdown lines (rows are newline-joined)
 * — the same injection class the annotation escaping guards against, on the
 * step-summary surface.
 *
 * Backslashes are escaped FIRST: GFM reads `\\` as a literal backslash, so a
 * title's own trailing `\` would otherwise consume the `\` we insert before `|`
 * (turning `\|` back into an unescaped column break). Doubling the value's own
 * backslashes up front keeps every later insert a real escape.
 */
function escapeTableCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * Escape a value used as the TEXT half of a Markdown `[text](url)` link inside a
 * table cell. On top of the cell escaping (backslashes, `|`, CR/LF), an unescaped
 * `]` closes the link early — so a bracketed title like `x](https://evil) y` would
 * retarget the visible link at the injected URL. Titles are workspace-authored and
 * often LLM-generated, so brackets are realistic; escape `[` and `]` (backslash).
 * `escapeTableCell` has already doubled the value's own backslashes, so the escape
 * we insert before a bracket can't be consumed by a preceding `\`. Plain (unlinked)
 * cells keep `escapeTableCell`.
 */
function escapeMarkdownLinkText(value: string): string {
  return escapeTableCell(value).replace(/([[\]])/g, '\\$1');
}

/**
 * Escape a URL for a Markdown `[text](url)` link: a literal `)` closes the link
 * early and whitespace / `|` / CR-LF break the link or the surrounding cell.
 */
function escapeMarkdownUrl(url: string): string {
  return url
    .replace(/[\r\n]+/g, '')
    .replace(/ /g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\|/g, '%7C');
}

/**
 * An id as inline code. A backtick or a line break in it would end the code
 * span or start a new Markdown line, so both are dropped.
 */
function inlineCode(id: string): string {
  return `\`${id.replace(/[`\r\n]/g, '')}\``;
}

/**
 * The Test cell of a results table: the human label, linked to the test-case
 * page (`dashboardUrl`) when the server sent one. The label sits in link-text
 * position, so it uses the bracket-aware escaper.
 */
function testCell(row: CiRunRow): string {
  // `|| ` not `?? `: an empty / whitespace-only title must fall back to the
  // id (a blank Test cell is useless), matching JUnit's `name?.trim() || id`.
  const label = row.title?.trim() || row.testId || row.resultId || row.runId || '(unknown)';
  return row.dashboardUrl
    ? `[${escapeMarkdownLinkText(label)}](${escapeMarkdownUrl(row.dashboardUrl)})`
    : escapeTableCell(label);
}

/**
 * The Result cell of a results table: the result id, linked to that result's
 * own page (`executionUrl`) when the server sent one. The id stays the link
 * text (not a constant word) so the column is scannable and clickable.
 */
function resultCell(row: CiRunRow): string {
  const resultId = row.resultId ?? '';
  return row.executionUrl && resultId
    ? `[${escapeMarkdownLinkText(resultId)}](${escapeMarkdownUrl(row.executionUrl)})`
    : escapeTableCell(resultId);
}

export function formatFailureCounts(summary: CiSummary): string {
  return [
    `${summary.failed} failed`,
    ...(summary.blocked ? [`${summary.blocked} blocked`] : []),
    ...(summary.cancelled ? [`${summary.cancelled} cancelled`] : []),
    ...(summary.errors ? [`${summary.errors} with errors`] : []),
  ].join(', ');
}

function runFailureLines(summary: CiSummary): string[] {
  return (summary.runFailures ?? []).map(
    failure =>
      `> Run ${inlineCode(failure.runId)} — ${failure.status}: ${inlineCode(failure.message)}`,
  );
}

/**
 * Markdown table for the GitHub job summary: the launch (or launches) the
 * dispatched tests belong to on a line of its own when the backend named one,
 * then one row per test with its result. A test that never dispatched because
 * it was already running names that other run's result, whose launch is not
 * this run and is left off the line.
 */
export function renderJobSummaryMarkdown(summary: CiSummary): string {
  const launches = launchIds(summary.results.filter(row => !isNonDispatchedStatus(row.status)));
  return [
    '## TestSprite results',
    '',
    ...runFailureLines(summary),
    `**${summary.passed}/${summary.total} passed** (${formatFailureCounts(summary)}, ${summary.skipped} skipped, ${summary.timedOut} timed out${summary.running ? `, ${summary.running} still running` : ''})`,
    '',
    ...(launches.length > 0
      ? [`${launches.length === 1 ? 'Run' : 'Runs'} ${launches.map(inlineCode).join(', ')}`, '']
      : []),
    '| Test | Status | Result |',
    '| --- | --- | --- |',
    ...summary.results.map(
      row => `| ${testCell(row)} | ${escapeTableCell(row.status)} | ${resultCell(row)} |`,
    ),
    '',
  ].join('\n');
}

/**
 * Escape a value destined for the DATA half of a workflow command (the text
 * after `::`). Per GitHub's rules, `%`, CR and LF are percent-encoded so a raw
 * multiline run error can never introduce a newline that starts a second
 * `::command::` line in the Actions output stream (`%` first, so the encodings
 * we add are not themselves re-encoded). The line is printed to a log a
 * terminal or the Actions viewer shows, so the server's text loses its escape
 * sequences and control characters ({@link terminalSafe}) once CR is encoded.
 */
export function escapeCommandData(value: string): string {
  return terminalSafe(value.replace(/%/g, '%25').replace(/\r/g, '%0D')).replace(/\n/g, '%0A');
}

/**
 * Escape a value destined for a command PROPERTY (e.g. `title=...`). Beyond the
 * data rules, `:` and `,` are encoded so the value cannot terminate the
 * property list or the command header.
 */
function escapeCommandProperty(value: string): string {
  return escapeCommandData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * Emit the GitHub-native surfaces. Self-gating on the standard env vars:
 * `$GITHUB_STEP_SUMMARY` (a file path Actions provides) receives the Markdown
 * table; `GITHUB_ACTIONS=true` enables one workflow command per non-passed run
 * on stdout (Actions parses workflow commands from stdout) — `::error::` for a
 * dispatched run that failed or timed out, `::warning::` for a test that never
 * ran (deferred / conflict / not_found / skipped), so a red annotation always
 * means a red-worthy outcome and never contradicts the exit code.
 * `force` (the `--gh-output` flag) emits the annotations even off-Actions;
 * the step summary still requires the env-provided file path to exist.
 * Both writes are best-effort: a broken summary file must not mask the gate.
 */
export function emitGithubOutputs(
  summary: CiSummary,
  env: NodeJS.ProcessEnv,
  sinks: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    appendFile: (path: string, content: string) => void;
    /**
     * Where `::error::` workflow-command lines go. Defaults to `stdout`; the
     * caller passes stderr under `--output json` so the machine envelope on
     * stdout stays parseable (the Actions runner processes workflow commands
     * on both streams).
     */
    annotations?: (line: string) => void;
  },
  opts: {
    force?: boolean;
    label?: string;
    /**
     * Pre-rendered job-summary Markdown (the execution report) that replaces
     * the local results table when the backend provided one.
     */
    markdown?: string;
  } = {},
): void {
  const label = opts.label ?? 'run';
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath === 'string' && summaryPath.length > 0) {
    try {
      sinks.appendFile(summaryPath, opts.markdown ?? renderJobSummaryMarkdown(summary));
    } catch {
      sinks.stderr(`[${label}] could not append to GITHUB_STEP_SUMMARY; continuing`);
    }
  }
  if (env.GITHUB_ACTIONS === 'true' || opts.force === true) {
    const annotate = sinks.annotations ?? sinks.stdout;
    for (const failure of summary.runFailures ?? []) {
      annotate(
        `::error title=TestSprite run ${escapeCommandProperty(failure.runId)}::${escapeCommandData(failure.message)}`,
      );
    }
    for (const row of summary.results) {
      if (row.status === 'passed' || row.status === 'running') continue;
      const detail = row.error !== undefined ? ` ${row.error}` : '';
      // Prefer this run's result page over the test-case page — on a failure the
      // result is what the reviewer wants to open. Falls back to the test-case
      // link (when the server sent no run link), then to nothing.
      const linkUrl = row.executionUrl ?? row.dashboardUrl;
      const link = linkUrl !== undefined ? ` ${linkUrl}` : '';
      // Escape both halves: a raw multiline run error (or a testId) must not be
      // able to smuggle a second workflow command into the Actions stream.
      const title = `TestSprite ${escapeCommandProperty(row.title?.trim() || row.testId || row.resultId || row.runId || '(unknown)')}`;
      const message = escapeCommandData(`status=${row.status}${detail}${link}`);
      // Severity mirrors the summary counters: never-dispatched rows are
      // warnings (they may not even gate the exit), real failures are errors.
      const severity = NON_DISPATCHED_STATUSES.has(row.status) ? 'warning' : 'error';
      annotate(`::${severity} title=${title}::${message}`);
    }
  }
}

/**
 * Emit the CI artifacts for a `--wait` run: the machine summary file (when
 * `--summary-file` is set) and the GitHub-native annotations + job-summary table
 * (when `--gh-output` or `GITHUB_ACTIONS=true`). One shared implementation for
 * every `--wait` command — `run` (single + `--all`) and `run --testlist` —
 * so the copies of this block can no longer drift (a
 * per-copy fix like the `notFound` fold reaching only one of them is what this
 * consolidates away). The caller reduces its own envelope to a `CiSummary` first
 * (`summarizeAcceptedPayload` for a batch, `summarizeSingleRun` for one run);
 * this owns only the two sinks and their best-effort writes. `label` names the
 * command in the failure messages (`[run]` / `[ci run]` / `[testlist]`).
 * Both writes are best-effort — a sink throwing must never change the exit code.
 */
export function emitCiArtifacts(
  summary: CiSummary,
  opts: { ghOutput?: boolean; summaryFile?: string; output?: string },
  io: { env: NodeJS.ProcessEnv; stdout: (line: string) => void; stderr: (line: string) => void },
  label: string,
  extra: { markdown?: string } = {},
): void {
  const ghEnabled = opts.ghOutput === true || io.env.GITHUB_ACTIONS === 'true';
  if (!ghEnabled && opts.summaryFile === undefined) return;
  if (opts.summaryFile !== undefined) {
    try {
      // The file gets the output names; everything else here reads the wire rows.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- `--summary-file` is an explicit operator-supplied CI-artifact output path; best-effort in try/catch.
      writeFileSync(opts.summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    } catch {
      io.stderr(`[${label}] could not write --summary-file ${opts.summaryFile}; continuing`);
    }
  }
  if (ghEnabled) {
    emitGithubOutputs(
      summary,
      io.env,
      {
        stdout: io.stdout,
        stderr: io.stderr,
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- `path` is the CI-provided `$GITHUB_STEP_SUMMARY` env path, never external input.
        appendFile: (path: string, content: string) => appendFileSync(path, content, 'utf8'),
        // Under --output json the run envelope owns stdout; workflow commands go
        // to stderr instead (the Actions runner parses both streams).
        annotations: opts.output === 'json' ? io.stderr : io.stdout,
      },
      { force: opts.ghOutput === true, label, markdown: extra.markdown },
    );
  }
}

/**
 * Hand the execution report to later steps: its JSON and Markdown are written
 * under `$RUNNER_TEMP` (else the OS temp dir) and their paths appended to
 * `$GITHUB_OUTPUT` as `execution-report-file` / `execution-report-markdown-file`.
 * The JSON names the launch the report describes `runId`, as the summary does.
 * Paths, not bodies — a step output is capped at 1 MiB and multi-line values
 * need heredoc escaping. No-op without `GITHUB_OUTPUT` (nothing can consume
 * them). Best-effort: a write failure is reported and never masks the gate.
 */
export function emitExecutionReportOutputs(
  ready: { report: ExecutionReport; markdown: string },
  io: { env: NodeJS.ProcessEnv; stderr: (line: string) => void },
): { jsonPath: string; markdownPath: string } | undefined {
  const outputPath = io.env.GITHUB_OUTPUT;
  if (!outputPath) return undefined;
  const dir = io.env.RUNNER_TEMP || tmpdir();
  const safeId = ready.report.runId.replace(/[^A-Za-z0-9_-]/g, '_');
  const jsonPath = join(dir, `testsprite-execution-report-${safeId}.json`);
  const markdownPath = join(dir, `testsprite-execution-report-${safeId}.md`);
  // A `key=value` output line ends at a newline, so a path carrying one would
  // smuggle a second output; such a path is skipped rather than escaped.
  if (/[\r\n]/.test(jsonPath) || /[\r\n]/.test(markdownPath)) {
    io.stderr(
      '[ci run] execution report outputs skipped: the temp directory path contains a newline',
    );
    return undefined;
  }
  try {
    // Owner-only: the report carries the run's narrative, error text, fix
    // prompts and screenshot links, and the runner's temp dir is shared.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Runner temp directory (`$RUNNER_TEMP` or the OS temp dir) plus a sanitised launch id; never caller input.
    writeFileSync(jsonPath, `${JSON.stringify(ready.report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Same runner temp directory and sanitised id as above.
    writeFileSync(markdownPath, ready.markdown, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    io.stderr(
      `[ci run] execution report files not written (${err instanceof Error ? err.message : String(err)}); continuing`,
    );
    return undefined;
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- GITHUB_OUTPUT is the runner-provided output path; only the two temp-file paths above are appended.
    appendFileSync(
      outputPath,
      `execution-report-file=${jsonPath}\nexecution-report-markdown-file=${markdownPath}\n`,
      'utf8',
    );
  } catch {
    io.stderr('[ci run] execution report outputs not appended to GITHUB_OUTPUT; continuing');
  }
  return { jsonPath, markdownPath };
}

/**
 * The job-summary Markdown for a batch that has a server execution report.
 *
 * The exit code comes from the CLI's own execution waits plus whatever did
 * not dispatch; the report describes only the execution. Usually they agree
 * and the summary is the report, byte for byte the App's comment. When they
 * do not — a run the CLI could not read or that timed out, a test refused
 * before dispatch, a retry error — the report alone would read "all passed"
 * under a red check, so the local verdict is stated first and the rows the
 * report cannot contain are appended. A red run whose failures the report
 * also shows agrees — the counts match — and keeps the App's comment as is.
 */
export function reconcileExecutionReportMarkdown(
  summary: CiSummary,
  ready: { report: ExecutionReport; markdown: string },
): string {
  const localNonPassed = summary.results.filter(row => row.status !== 'passed');
  const { stats } = ready.report;
  const agrees =
    !summary.runFailures?.length &&
    !summary.errors &&
    !summary.cancelled &&
    summary.skipped === 0 &&
    summary.timedOut === 0 &&
    summary.passed === stats.passed &&
    summary.failed === stats.failed &&
    (summary.blocked ?? 0) === stats.blocked &&
    summary.total === stats.total;
  if (agrees) return ready.markdown;
  const reported = new Set(ready.report.tests.map(t => t.id));
  const missing = localNonPassed.filter(row => !row.resultId || !reported.has(row.resultId));
  const banner = [
    '> [!WARNING]',
    `> **CI gate: ${summary.passed} of ${summary.total} passed, ${formatFailureCounts(summary)}, ${summary.skipped} skipped, ${summary.timedOut} timed out${summary.running ? `, ${summary.running} still running` : ''}.**`,
    ...runFailureLines(summary),
    "> The check's result comes from the CLI's own wait for each execution. The report below is the server's view of run " +
      inlineCode(ready.report.runId) +
      (missing.length > 0 ? ' and does not cover the rows listed at the end.' : '.'),
    '',
  ];
  const appendix =
    missing.length > 0
      ? [
          '',
          '### Not reflected in the execution report',
          '',
          '| Test | Status | Detail | Result |',
          '| --- | --- | --- | --- |',
          ...missing.map(
            row =>
              `| ${testCell(row)} | ${escapeTableCell(row.status)} | ${escapeTableCell(row.error ?? '')} | ${resultCell(row)} |`,
          ),
          '',
        ]
      : [];
  return [...banner, ready.markdown.replace(/\s+$/, ''), ...appendix, ''].join('\n');
}

/** Keep the historical failed step output for existing Actions gates. */
export function emitCiStepOutputs(
  summary: CiSummary,
  io: { env: NodeJS.ProcessEnv; stderr: (line: string) => void },
): void {
  const outputPath = io.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const blocked = summary.blocked ?? 0;
  const failedRuns = new Set(
    summary.results
      .filter(row => ['failed', 'blocked', 'cancelled', 'error'].includes(row.status))
      .map(row => row.runId),
  );
  const runFailures = summary.runFailures ?? [];
  const additionalFailures = runFailures.filter(
    f => f.status !== 'timeout' && !failedRuns.has(f.runId),
  ).length;
  const additionalTimeouts = runFailures.filter(f => f.status === 'timeout').length;
  const gateFailures =
    summary.failed +
    blocked +
    (summary.cancelled ?? 0) +
    (summary.errors ?? 0) +
    additionalFailures;
  const content =
    [
      `total=${summary.total}`,
      `passed=${summary.passed}`,
      `failed=${gateFailures}`,
      `skipped=${summary.skipped}`,
      `timedOut=${summary.timedOut + additionalTimeouts}`,
      `blocked=${blocked}`,
      `failedOnly=${summary.failed}`,
      ...(summary.running ? [`running=${summary.running}`] : []),
    ].join('\n') + '\n';
  try {
    // Runner-provided output file; only numeric counter values are appended.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- GITHUB_OUTPUT is an explicit runner/operator-provided output path, not API/test content; only computed numeric counters are appended.
    appendFileSync(outputPath, content, 'utf8');
  } catch {
    io.stderr('[ci run] could not append to GITHUB_OUTPUT; continuing');
  }
}
