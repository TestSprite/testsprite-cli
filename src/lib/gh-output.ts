import { appendFileSync, writeFileSync } from 'node:fs';

/**
 * CI-native output layer for the run path (issue #99, reshaped from
 * the withdrawn top-level `ci` command per the #264 review). Covers both a
 * single `test run <test-id> --wait` and the `test run --all --wait` batch.
 *
 * A `--wait` run presents its result in the formats CI consumes:
 *   (a) a stable machine summary `{total, passed, failed, timedOut, runs[]}`
 *       written to `--summary-file <path>` when requested,
 *   (b) a Markdown results table appended to `$GITHUB_STEP_SUMMARY` when
 *       running under GitHub Actions,
 *   (c) one `::error::` workflow-command line per non-passed run so failures
 *       annotate the PR checks tab.
 * Activation: `GITHUB_ACTIONS=true` in the environment, or the explicit
 * `--gh-output` flag (which forces the annotations even off-Actions, so the
 * behavior is previewable locally). All writes are best-effort: a broken
 * summary file must never mask the batch gate's exit code.
 */

export interface CiRunRow {
  testId: string;
  runId?: string;
  status: string;
  dashboardUrl?: string;
  error?: string;
}

export interface CiSummary {
  total: number;
  passed: number;
  failed: number;
  timedOut: number;
  runs: CiRunRow[];
}

/**
 * Reduce a non-dispatched bucket (`deferred` / `conflicts` / `notFound`) into
 * CI rows. Items are either bare testId strings (`notFound`) or
 * `{ testId, currentRunId? }` objects; both shapes are handled. `note` becomes
 * the row's error text so the annotation explains why the item did not run.
 */
function bucketRows(bucket: unknown, status: string, note: string): CiRunRow[] {
  if (!Array.isArray(bucket)) return [];
  return bucket.map(item => {
    const rec =
      item !== null && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
    const testId =
      typeof item === 'string' ? item : typeof rec?.testId === 'string' ? rec.testId : '';
    const currentRunId = typeof rec?.currentRunId === 'string' ? rec.currentRunId : undefined;
    return {
      testId,
      status,
      ...(currentRunId ? { runId: currentRunId } : {}),
      error: note,
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
 * non-passed rows: those buckets already force a non-zero exit (deferred /
 * timeout → 7, all-conflict → 6) but were previously absent from the summary,
 * so a partial batch like `1 accepted passed + 1 deferred` read as "1/1 passed"
 * with no annotation. (`skippedFrontend` / `skippedIntegration` are NOT folded
 * in — they exit 0 and are the Action layer's allow-partial concern.)
 */
export function summarizeAcceptedPayload(
  capturedJson: string,
  opts: { notFoundNote?: string } = {},
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
    deferred?: unknown;
    conflicts?: unknown;
    notFound?: unknown;
  } = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const acceptedRows: CiRunRow[] = Array.isArray(payload.accepted)
    ? payload.accepted
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
            ...(typeof row.runId === 'string' ? { runId: row.runId } : {}),
            status: String(row.status ?? 'unknown'),
            ...(typeof row.dashboardUrl === 'string' ? { dashboardUrl: row.dashboardUrl } : {}),
            ...(typeof errorMessage === 'string' ? { error: errorMessage } : {}),
          };
        })
    : [];
  const rows: CiRunRow[] = [
    ...acceptedRows,
    ...bucketRows(payload.deferred, 'deferred', 'rate-deferred (not dispatched)'),
    ...bucketRows(payload.conflicts, 'conflict', 'already in flight (not dispatched)'),
    // Default note is `test rerun`'s cause (a not-found id has no replayable
    // run). `testlist run` passes its own — a not-found `--case` id is one that
    // is not a member of the list — so the annotation/artifact don't state the
    // wrong reason on the surface this whole layer exists to serve.
    ...bucketRows(
      payload.notFound,
      'not_found',
      opts.notFoundNote ?? 'no replayable run (not dispatched)',
    ),
  ];
  const passed = rows.filter(row => row.status === 'passed').length;
  const timedOut = rows.filter(row => row.status === 'timeout').length;
  const failed = rows.length - passed - timedOut;
  return { total: rows.length, passed, failed, timedOut, runs: rows };
}

/**
 * Reduce a single `test run <test-id> --wait` result into the same CI summary
 * shape as the batch path, so `--gh-output` / `--summary-file` behave
 * identically for a one-test CI job. Unlike the batch envelope, a single
 * RunResponse carries `error` as a raw string (not `{ message }`) and
 * `dashboardUrl` as `string | null`; both are normalized here.
 */
export function summarizeSingleRun(run: {
  testId?: string;
  runId?: string;
  status?: string;
  dashboardUrl?: string | null;
  error?: string | null;
}): CiSummary {
  const row: CiRunRow = {
    testId: String(run.testId ?? ''),
    ...(typeof run.runId === 'string' ? { runId: run.runId } : {}),
    status: String(run.status ?? 'unknown'),
    ...(typeof run.dashboardUrl === 'string' ? { dashboardUrl: run.dashboardUrl } : {}),
    ...(typeof run.error === 'string' && run.error.length > 0 ? { error: run.error } : {}),
  };
  const passed = row.status === 'passed' ? 1 : 0;
  const timedOut = row.status === 'timeout' ? 1 : 0;
  const failed = 1 - passed - timedOut;
  return { total: 1, passed, failed, timedOut, runs: [row] };
}

/**
 * Escape a value for a Markdown table cell. A raw `|` would break the column
 * layout and a CR/LF would inject extra Markdown lines (rows are newline-joined)
 * — the same injection class the annotation escaping guards against, on the
 * step-summary surface.
 */
function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
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

/** Markdown table for the GitHub job summary. */
export function renderJobSummaryMarkdown(summary: CiSummary): string {
  return [
    '## TestSprite results',
    '',
    `**${summary.passed}/${summary.total} passed** (${summary.failed} failed, ${summary.timedOut} timed out)`,
    '',
    '| Test | Status | Run |',
    '| --- | --- | --- |',
    ...summary.runs.map(row => {
      const run = row.dashboardUrl
        ? `[dashboard](${escapeMarkdownUrl(row.dashboardUrl)})`
        : escapeTableCell(row.runId ?? '');
      return `| ${escapeTableCell(row.testId)} | ${escapeTableCell(row.status)} | ${run} |`;
    }),
    '',
  ].join('\n');
}

/**
 * Escape a value destined for the DATA half of a workflow command (the text
 * after `::`). Per GitHub's rules, `%`, CR and LF are percent-encoded so a raw
 * multiline run error can never introduce a newline that starts a second
 * `::command::` line in the Actions output stream (`%` first, so the encodings
 * we add are not themselves re-encoded).
 */
function escapeCommandData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
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
 * table; `GITHUB_ACTIONS=true` enables one `::error::` workflow command per
 * non-passed run on stdout (Actions parses workflow commands from stdout).
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
  opts: { force?: boolean; label?: string } = {},
): void {
  const label = opts.label ?? 'run';
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath === 'string' && summaryPath.length > 0) {
    try {
      sinks.appendFile(summaryPath, renderJobSummaryMarkdown(summary));
    } catch {
      sinks.stderr(`[${label}] could not append to GITHUB_STEP_SUMMARY; continuing`);
    }
  }
  if (env.GITHUB_ACTIONS === 'true' || opts.force === true) {
    const annotate = sinks.annotations ?? sinks.stdout;
    for (const row of summary.runs) {
      if (row.status === 'passed') continue;
      const detail = row.error !== undefined ? ` ${row.error}` : '';
      const link = row.dashboardUrl !== undefined ? ` ${row.dashboardUrl}` : '';
      // Escape both halves: a raw multiline run error (or a testId) must not be
      // able to smuggle a second workflow command into the Actions stream.
      const title = `TestSprite ${escapeCommandProperty(row.testId)}`;
      const message = escapeCommandData(`status=${row.status}${detail}${link}`);
      annotate(`::error title=${title}::${message}`);
    }
  }
}

/**
 * Emit the CI artifacts for a `--wait` run: the machine summary file (when
 * `--summary-file` is set) and the GitHub-native annotations + job-summary table
 * (when `--gh-output` or `GITHUB_ACTIONS=true`). One shared implementation for
 * every `--wait` command — `test run` (single + `--all`), `test rerun`, and
 * `testlist run` — so the four copies of this block can no longer drift (a
 * per-copy fix like the `notFound` fold reaching only one of them is what this
 * consolidates away). The caller reduces its own envelope to a `CiSummary` first
 * (`summarizeAcceptedPayload` for a batch, `summarizeSingleRun` for one run);
 * this owns only the two sinks and their best-effort writes. `label` names the
 * command in the failure messages (`[run]` / `[rerun]` / `[testlist run]`).
 * Both writes are best-effort — a sink throwing must never change the exit code.
 */
export function emitCiArtifacts(
  summary: CiSummary,
  opts: { ghOutput?: boolean; summaryFile?: string; output?: string },
  io: { env: NodeJS.ProcessEnv; stdout: (line: string) => void; stderr: (line: string) => void },
  label: string,
): void {
  const ghEnabled = opts.ghOutput === true || io.env.GITHUB_ACTIONS === 'true';
  if (!ghEnabled && opts.summaryFile === undefined) return;
  if (opts.summaryFile !== undefined) {
    try {
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
      { force: opts.ghOutput === true, label },
    );
  }
}
