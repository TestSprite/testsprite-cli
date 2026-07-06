import { createWriteStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localValidationError, TransportError } from './errors.js';

export type JUnitReportFormat = 'junit';

/** Minimal testcase input shared by batch run and batch rerun poll results. */
export interface JUnitTestResult {
  testId: string;
  runId?: string;
  status: string;
  /** Observed on polled runs; used for classname when --project is omitted. */
  projectId?: string;
  error?: { code: string; message: string; exitCode?: number };
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
  opts: { projectId?: string },
  results: ReadonlyArray<{ projectId?: string }>,
): string {
  if (opts.projectId) return opts.projectId;
  const fromPoll = results.map(r => r.projectId).find((id): id is string => !!id);
  if (fromPoll) return fromPoll;
  throw localValidationError(
    'project',
    '--report junit requires --project <id> when the project cannot be inferred from run results',
  );
}

/**
 * Escape text for inclusion in XML element bodies and double-quoted attributes.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

type JUnitOutcome = 'passed' | 'failure' | 'error' | 'skipped';

function classifyJUnitOutcome(status: string, error?: JUnitTestResult['error']): JUnitOutcome {
  if (status === 'passed') return 'passed';
  if (status === 'skipped') return 'skipped';
  if (status === 'error' || error?.exitCode === 3) return 'error';
  return 'failure';
}

function failureMessage(result: JUnitTestResult): string {
  if (result.error?.message) return result.error.message;
  if (result.error?.code) return result.error.code;
  return result.status;
}

function renderTestcase(result: JUnitTestResult, classname: string): string {
  const outcome = classifyJUnitOutcome(result.status, result.error);
  const name = escapeXml(result.testId);
  const cls = escapeXml(classname);
  const lines = [`    <testcase classname="${cls}" name="${name}" time="0">`];

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
    lines.push(`      <skipped/>`);
  }

  lines.push('    </testcase>');
  return lines.join('\n');
}

/**
 * Build a JUnit XML document from batch poll results. Duration is `0` in v1
 * because batch poll envelopes do not carry per-run timing.
 */
export function buildJUnitReport(opts: JUnitReportBuildOptions): string {
  const results = opts.results;
  let failures = 0;
  let errors = 0;
  let skipped = 0;

  for (const result of results) {
    const outcome = classifyJUnitOutcome(result.status, result.error);
    if (outcome === 'failure') failures++;
    else if (outcome === 'error') errors++;
    else if (outcome === 'skipped') skipped++;
  }

  const suiteName = escapeXml(opts.suiteName);
  const testcases = results.map(r => renderTestcase(r, opts.classname)).join('\n');

  return [
    XML_DECL,
    '<testsuites>',
    `  <testsuite name="${suiteName}" tests="${results.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="0">`,
    testcases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

async function assertReportFileParent(rawPath: string): Promise<string> {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw localValidationError('report-file', 'must be a non-empty file path');
  }
  const resolved = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
  if (resolved.endsWith('/') || resolved.endsWith('\\')) {
    throw localValidationError('report-file', 'must point to a file, not a directory');
  }

  const parent = dirname(resolved);
  let parentStat;
  try {
    parentStat = await stat(parent);
  } catch {
    throw localValidationError('report-file', `parent directory does not exist: ${parent}`);
  }
  if (!parentStat.isDirectory()) {
    throw localValidationError('report-file', `parent path is not a directory: ${parent}`);
  }

  let targetStat;
  try {
    targetStat = await stat(resolved);
  } catch {
    return resolved;
  }
  if (targetStat.isDirectory()) {
    throw localValidationError('report-file', `must point to a file, not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Atomically write JUnit XML to `--report-file` (temp sibling + rename).
 */
export async function writeJUnitReportFile(rawPath: string, xml: string): Promise<void> {
  const resolved = await assertReportFileParent(rawPath);
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
