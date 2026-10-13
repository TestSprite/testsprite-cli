import { createWriteStream, statSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localValidationError, TransportError } from './errors.js';
import { isNonDispatchedStatus, type CiSummary } from './gh-output.js';

export type JUnitReportFormat = 'junit';

/** Minimal testcase input shared by batch run and batch rerun poll results. */
export interface JUnitTestResult {
  testId: string;
  runId?: string;
  status: string;
  /** Observed on polled runs; used for classname when --project is omitted. */
  projectId?: string;
  /** This row's own `classname`, when the batch spans several projects. */
  classname?: string;
  error?: { code: string; message: string; exitCode?: number };
  /** Why a member was skipped before dispatch. */
  skipReason?: string;
  /**
   * Human-readable test name for the `testcase name` attribute. Falls back to
   * `testId` when absent (older data / a run whose name could not be resolved).
   * A CI test tab renders this, not the UUID.
   */
  name?: string;
  /**
   * Wall-clock duration of the run in seconds, for `testcase time`. Derived from
   * the poll result's `startedAt` (or `createdAt`) and `finishedAt`; omitted when timing is absent
   * (rendered as `0`, the pre-fix behaviour).
   */
  durationSeconds?: number;
}

/**
 * Duration in seconds between two ISO timestamps, or `undefined` when either is
 * missing / unparseable / negative (clock skew). Prefer startedAt, falling back
 * to createdAt on servers that do not record a start. Kept ≥ 0.
 */
export function durationSecondsBetween(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  createdAt?: string | null,
): number | undefined {
  startedAt = startedAt ?? createdAt;
  if (!startedAt || !finishedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  const seconds = (end - start) / 1000;
  return seconds >= 0 ? seconds : undefined;
}

/** Format a duration for the JUnit `time` attribute (3 dp; absent → `0`). */
function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || Number.isNaN(seconds)) return '0';
  return (Math.round(seconds * 1000) / 1000).toString();
}

export interface JUnitReportBuildOptions {
  suiteName: string;
  classname: string;
  results: readonly JUnitTestResult[];
}

export interface JUnitReportFlagOptions {
  report?: JUnitReportFormat;
  reportFile?: string;
  reportSuiteName?: string;
  wait: boolean;
  /** True when the invocation is a batch path (run --all or rerun batch). */
  batchPath: boolean;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * Parse `--report <format>`. Only `junit` is accepted in v1.
 */
export function parseJUnitReportFormat(raw: string | undefined): JUnitReportFormat | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'junit') return 'junit';
  throw localValidationError('report', `unsupported report format "${raw}" — accepted: junit`);
}

/**
 * Validate `--report` / `--report-file` / `--report-suite-name` combinations.
 * Report export is a sidecar artifact for batch `--wait` runs only.
 */
export function assertJUnitReportOptions(opts: JUnitReportFlagOptions): void {
  if (opts.report === undefined) {
    if (opts.reportFile !== undefined && opts.reportFile !== '') {
      throw localValidationError('report-file', '--report-file requires --report junit');
    }
    if (opts.reportSuiteName !== undefined && opts.reportSuiteName !== '') {
      throw localValidationError(
        'report-suite-name',
        '--report-suite-name requires --report junit',
      );
    }
    return;
  }

  if (!opts.batchPath) {
    throw localValidationError(
      'report',
      '--report junit only applies to batch --wait runs (test run --all, or test rerun --all / multiple test ids)',
    );
  }
  if (!opts.wait) {
    throw localValidationError(
      'report',
      '--report junit requires --wait (the report is written after batch polling completes)',
    );
  }
  if (opts.reportFile === undefined || opts.reportFile === '') {
    throw localValidationError('report-file', '--report junit requires --report-file <path>');
  }
}

/**
 * Resolve the project id used for JUnit classname / default suite naming.
 * Prefer explicit `--project`, then ids observed on polled run rows.
 */
export function resolveBatchReportProjectId(
  opts: { projectId?: string; projectIdByTestId?: ReadonlyMap<string, string> },
  results: ReadonlyArray<{ projectId?: string }>,
): string {
  if (opts.projectId) return opts.projectId;
  // Explicit ids that span several projects have no single `--project`; each
  // row carries its own project as its classname and the suite gets this token.
  const known = new Set(opts.projectIdByTestId?.values());
  if (known.size > 1) return 'multiple-projects';
  const fromPoll = results.map(r => r.projectId).find((id): id is string => !!id);
  if (fromPoll) return fromPoll;
  if (known.size === 1) return [...known][0]!;
  throw localValidationError(
    'project',
    '--report junit requires --project <id> when the project cannot be inferred from run results',
  );
}

/**
 * Characters XML 1.0 forbids anywhere in a document: the `Char` production
 * allows only #x9, #xA, #xD, [#x20-#xD7FF], [#xE000-#xFFFD] and
 * [#x10000-#x10FFFF]. No entity can represent the excluded characters, so
 * they are stripped rather than escaped — a single one in a free-text run
 * message (LLM / server supplied) makes strict parsers reject the whole
 * report. Tab, newline and carriage return are legal and preserved.
 */
// eslint-disable-next-line no-control-regex
const XML_1_0_ILLEGAL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/**
 * Escape text for inclusion in XML element bodies and double-quoted attributes.
 */
export function escapeXml(text: string): string {
  return text
    .replace(XML_1_0_ILLEGAL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

type JUnitOutcome = 'passed' | 'failure' | 'error' | 'skipped';

function classifyJUnitOutcome(status: string, error?: JUnitTestResult['error']): JUnitOutcome {
  if (status === 'passed') return 'passed';
  if (isNonDispatchedStatus(status)) return 'skipped';
  if (status === 'error' || error?.exitCode === 3) return 'error';
  return 'failure';
}

function failureMessage(result: JUnitTestResult): string {
  if (result.error?.message) return result.error.message;
  if (result.error?.code) return result.error.code;
  return result.status;
}

function renderTestcase(result: JUnitTestResult, classname: string, displayName?: string): string {
  const outcome = classifyJUnitOutcome(result.status, result.error);
  // A readable CI test tab keys on `name`: prefer the human test name, fall back
  // to the id. The UUID is preserved as a `testId` attribute (ignored by
  // renderers, read by machine consumers) so the switch loses no information.
  // `displayName` carries the precomputed disambiguated name for colliding
  // groups (see resolveJUnitDisplayNames).
  const name = escapeXml(displayName ?? (result.name?.trim() || result.testId));
  const cls = escapeXml(classname);
  const time = formatTime(result.durationSeconds);
  const idAttr = ` testId="${escapeXml(result.testId)}"`;
  const runAttr = result.runId ? ` runId="${escapeXml(result.runId)}"` : '';
  const lines = [
    `    <testcase classname="${cls}" name="${name}"${idAttr}${runAttr} time="${time}">`,
  ];

  if (outcome === 'failure') {
    const message = escapeXml(failureMessage(result));
    const type = escapeXml(result.status);
    const body = escapeXml(
      [
        `status: ${result.status}`,
        result.runId ? `runId: ${result.runId}` : undefined,
        result.error?.code ? `code: ${result.error.code}` : undefined,
        result.error?.message ? `message: ${result.error.message}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    lines.push(`      <failure message="${message}" type="${type}">${body}</failure>`);
  } else if (outcome === 'error') {
    const message = escapeXml(failureMessage(result));
    const type = escapeXml(result.error?.code ?? result.status);
    const body = escapeXml(
      [
        result.error?.code ? `code: ${result.error.code}` : undefined,
        result.error?.message ? `message: ${result.error.message}` : undefined,
        result.runId ? `runId: ${result.runId}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    lines.push(`      <error message="${message}" type="${type}">${body}</error>`);
  } else if (outcome === 'skipped') {
    lines.push(
      `      <skipped message="${escapeXml(result.skipReason ?? failureMessage(result))}"/>`,
    );
  }

  lines.push('    </testcase>');
  return lines.join('\n');
}

/**
 * Standard JUnit consumers (GitLab, Jenkins) key a testcase on classname+name
 * and ignore extra attributes, so rows sharing both collapse into one — a
 * same-name pair from a multi-project list then loses one verdict and one
 * run's diagnostics (#515). The stable logical testId — not the ephemeral
 * runId, which would break cross-run comparison — joins the standard identity
 * for colliding groups only: unique names render exactly as before.
 */
function resolveJUnitDisplayNames(
  results: ReadonlyArray<JUnitTestResult>,
  fallbackClassname: string,
): Array<string | undefined> {
  const rawNames = results.map(result => result.name?.trim() || result.testId);
  const names = [...rawNames];
  // XML consumers normalize attribute whitespace: line endings collapse first
  // (CRLF/CR → LF), then tabs/newlines/carriage returns each become a space.
  // Raw-distinct names can therefore share an identity downstream, so the
  // collision keys use the normalized form; rendering keeps the original text.
  const attributeKey = (value: string): string =>
    value.replace(/\r\n?/g, '\n').replace(/[\n\t]/g, ' ');
  const keyOf = (classname: string, name: string): string =>
    `${attributeKey(classname)}\u0000${attributeKey(name)}`;
  // The suffix must stay injective under attributeKey normalization, or two raw-distinct
  // ids ("a\tb" vs "a b") re-collide after suffixing and the round cap gives up leaving
  // duplicate identities. JSON-escaping (minus the surrounding quotes) encodes control
  // characters as visible two-char escapes, so distinct ids render distinct suffixes
  // that normalization cannot fold; ids without escapes render unchanged.
  const displayTestId = (testId: string): string => JSON.stringify(testId).slice(1, -1);
  // Suffixing can itself collide with a row whose human title already looks
  // like a suffixed one ("Checkout [case-a]" as a literal name), so iterate
  // until no (classname, name) pair collides. Each round's colliding set gets
  // an injective encoded suffix, so the set ends pairwise distinct and the
  // loop terminates. A group whose rows all share one testId can never be
  // separated by any suffix — the rows are exact duplicates — so it is left
  // alone instead of spinning to the round cap (testlist run can pass the
  // same id twice, billing each row).
  for (let round = 0; round <= results.length; round++) {
    const groups = new Map<string, { count: number; testIds: Set<string> }>();
    results.forEach((result, index) => {
      const key = keyOf(result.classname ?? fallbackClassname, names[index]!);
      const group = groups.get(key) ?? { count: 0, testIds: new Set<string>() };
      group.count += 1;
      group.testIds.add(result.testId);
      groups.set(key, group);
    });
    let changed = false;
    results.forEach((result, index) => {
      const key = keyOf(result.classname ?? fallbackClassname, names[index]!);
      const group = groups.get(key)!;
      if (group.count > 1 && group.testIds.size > 1) {
        names[index] = `${names[index]} [${displayTestId(result.testId)}]`;
        changed = true;
      }
    });
    if (!changed) break;
  }
  return names.map((name, index) => (name === rawNames[index] ? undefined : name));
}

/**
 * Build a JUnit XML document from batch results, including skipped members. Per-`testcase` `time` is
 * the run's wall-clock duration (from `startedAt`/`finishedAt`); the `testsuite`
 * `time` is their sum. `time` falls back to `0` for a run with no timing.
 */
export function buildJUnitReport(opts: JUnitReportBuildOptions): string {
  const results = opts.results;
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  let totalSeconds = 0;

  for (const result of results) {
    const outcome = classifyJUnitOutcome(result.status, result.error);
    if (outcome === 'failure') failures++;
    else if (outcome === 'error') errors++;
    else if (outcome === 'skipped') skipped++;
    if (typeof result.durationSeconds === 'number' && result.durationSeconds >= 0) {
      totalSeconds += result.durationSeconds;
    }
  }

  const suiteName = escapeXml(opts.suiteName);
  const displayNames = resolveJUnitDisplayNames(results, opts.classname);
  const testcases = results
    .map((r, index) => renderTestcase(r, r.classname ?? opts.classname, displayNames[index]))
    .join('\n');

  return [
    XML_DECL,
    '<testsuites>',
    `  <testsuite name="${suiteName}" tests="${results.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${formatTime(totalSeconds)}">`,
    testcases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

/**
 * The summary's non-dispatched rows (deferred / conflict / not-found) as
 * skipped JUnit results. Accepted rows carry run statuses and today never
 * match `isNonDispatchedStatus`, but the two vocabularies are only disjoint
 * by convention: `skipped` is a word both could use. So a member already in
 * `dispatched` (the polled results the caller is writing) is left out here
 * rather than trusted to stay apart, which keeps `tests` from counting one
 * member twice if the server ever reports such a status for an admitted run.
 */
export function skippedJUnitResultsFromSummary(
  summary: CiSummary,
  dispatched: ReadonlyArray<Pick<JUnitTestResult, 'testId'>> = [],
): JUnitTestResult[] {
  const alreadyIncluded = new Set(dispatched.map(row => row.testId));
  return summary.runs
    .filter(row => isNonDispatchedStatus(row.status) && !alreadyIncluded.has(row.testId))
    .map(row => ({ testId: row.testId, status: 'skipped', skipReason: row.error ?? row.status }));
}

/**
 * Check that an output artifact path (`--report-file`, `--summary-file`) can be
 * written: non-empty, not a directory, and inside an existing directory.
 * Returns the resolved absolute path.
 *
 * Called in each command's pre-flight, before anything is dispatched or billed,
 * so a mistyped directory fails fast with exit 5 instead of surfacing only after
 * a full batch has run. The write itself re-checks (the directory can vanish in
 * between).
 */
export function assertArtifactPath(field: 'report-file' | 'summary-file', rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw localValidationError(field, 'must be a non-empty file path');
  }
  const resolved = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
  if (resolved.endsWith('/') || resolved.endsWith('\\')) {
    throw localValidationError(field, 'must point to a file, not a directory');
  }

  const parent = dirname(resolved);
  let parentStat;
  try {
    parentStat = statSync(parent);
  } catch {
    throw localValidationError(field, `parent directory does not exist: ${parent}`);
  }
  if (!parentStat.isDirectory()) {
    throw localValidationError(field, `parent path is not a directory: ${parent}`);
  }

  let targetStat;
  try {
    targetStat = statSync(resolved);
  } catch {
    return resolved;
  }
  if (targetStat.isDirectory()) {
    throw localValidationError(field, `must point to a file, not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Atomically write JUnit XML to `--report-file` (temp sibling + rename).
 */
export async function writeJUnitReportFile(rawPath: string, xml: string): Promise<void> {
  const resolved = assertArtifactPath('report-file', rawPath);
  const parent = dirname(resolved);
  const tmpPath = join(parent, `.${basename(resolved)}.tmp-${randomUUID()}`);

  await new Promise<void>((resolvePromise, reject) => {
    const stream = createWriteStream(tmpPath, { encoding: 'utf8' });
    let streamError: Error | null = null;
    stream.on('error', err => {
      streamError = err instanceof Error ? err : new Error(String(err));
    });
    stream.write(xml, err => {
      if (err) {
        streamError = err instanceof Error ? err : new Error(String(err));
      }
      stream.end(() => {
        if (streamError) {
          unlink(tmpPath).catch(() => undefined);
          reject(
            new TransportError(`Failed to write --report-file ${resolved}: ${streamError.message}`),
          );
          return;
        }
        rename(tmpPath, resolved)
          .then(() => resolvePromise())
          .catch(renameErr => {
            unlink(tmpPath).catch(() => undefined);
            reject(
              new TransportError(
                `Failed to write --report-file ${resolved}: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
              ),
            );
          });
      });
    });
  });
}
