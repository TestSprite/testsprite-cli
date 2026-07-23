/**
 * CI-native output layer for the batch run path (issue #99, reshaped from
 * the withdrawn top-level `ci` command per the #264 review).
 *
 * `test run --all --wait` presents its result in the formats CI consumes:
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
 * Reduce the batch command's JSON payload into the CI summary. The parse is
 * defensive: it reads the same `accepted[]` rows the automation contract
 * documents, and anything unparseable (dry-run envelope, partial output
 * after a timeout) reduces to an empty run list rather than a crash.
 */
export function summarizeAcceptedPayload(capturedJson: string): CiSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(capturedJson);
  } catch {
    // Not JSON at all (dry-run banner path or truncated output): no rows.
    parsed = undefined;
  }
  // `JSON.parse('null')` and non-object payloads are valid JSON but carry no
  // batch envelope — treat them like unparseable input instead of crashing.
  const payload: { accepted?: unknown } =
    parsed !== null && typeof parsed === 'object' ? (parsed as { accepted?: unknown }) : {};
  const rows: CiRunRow[] = Array.isArray(payload.accepted)
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
  const passed = rows.filter(row => row.status === 'passed').length;
  const timedOut = rows.filter(row => row.status === 'timeout').length;
  const failed = rows.length - passed - timedOut;
  return { total: rows.length, passed, failed, timedOut, runs: rows };
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
    ...summary.runs.map(
      row =>
        `| ${row.testId} | ${row.status} | ${
          row.dashboardUrl ? `[dashboard](${row.dashboardUrl})` : (row.runId ?? '')
        } |`,
    ),
    '',
  ].join('\n');
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
  opts: { force?: boolean } = {},
): void {
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (typeof summaryPath === 'string' && summaryPath.length > 0) {
    try {
      sinks.appendFile(summaryPath, renderJobSummaryMarkdown(summary));
    } catch {
      sinks.stderr('[run] could not append to GITHUB_STEP_SUMMARY; continuing');
    }
  }
  if (env.GITHUB_ACTIONS === 'true' || opts.force === true) {
    const annotate = sinks.annotations ?? sinks.stdout;
    for (const row of summary.runs) {
      if (row.status === 'passed') continue;
      const detail = row.error !== undefined ? ` ${row.error}` : '';
      const link = row.dashboardUrl !== undefined ? ` ${row.dashboardUrl}` : '';
      annotate(`::error title=TestSprite ${row.testId}::status=${row.status}${detail}${link}`);
    }
  }
}
