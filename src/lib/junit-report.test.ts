import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import {
  assertJUnitReportOptions,
  buildJUnitReport,
  durationSecondsBetween,
  escapeXml,
  parseJUnitReportFormat,
  resolveBatchReportProjectId,
  writeJUnitReportFile,
  type JUnitTestResult,
} from './junit-report.js';

describe('durationSecondsBetween', () => {
  it('computes seconds between two ISO timestamps', () => {
    expect(durationSecondsBetween('2026-08-17T10:00:00.000Z', '2026-08-17T10:00:12.500Z')).toBe(
      12.5,
    );
  });
  it('returns undefined when a timestamp is missing / unparseable / negative', () => {
    expect(durationSecondsBetween(null, '2026-08-17T10:00:00.000Z')).toBeUndefined();
    expect(durationSecondsBetween('2026-08-17T10:00:00.000Z', undefined)).toBeUndefined();
    expect(durationSecondsBetween('nonsense', '2026-08-17T10:00:00.000Z')).toBeUndefined();
    // finishedAt before startedAt (clock skew) → undefined, not a negative time.
    expect(
      durationSecondsBetween('2026-08-17T10:00:05.000Z', '2026-08-17T10:00:00.000Z'),
    ).toBeUndefined();
  });
});

function makeResult(overrides: Partial<JUnitTestResult> & { testId: string }): JUnitTestResult {
  return {
    status: 'passed',
    ...overrides,
  };
}

describe('escapeXml', () => {
  it('escapes XML special characters', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeXml('test_abc123')).toBe('test_abc123');
  });
});

describe('parseJUnitReportFormat', () => {
  it('accepts junit', () => {
    expect(parseJUnitReportFormat('junit')).toBe('junit');
  });

  it('returns undefined for absent value', () => {
    expect(parseJUnitReportFormat(undefined)).toBeUndefined();
    expect(parseJUnitReportFormat('')).toBeUndefined();
  });

  it('rejects unknown formats', () => {
    expect(() => parseJUnitReportFormat('html')).toThrowError(ApiError);
    try {
      parseJUnitReportFormat('html');
    } catch (err) {
      expect((err as ApiError).code).toBe('VALIDATION_ERROR');
      expect((err as ApiError).exitCode).toBe(5);
    }
  });
});

describe('assertJUnitReportOptions', () => {
  it('allows absent report flags', () => {
    expect(() => assertJUnitReportOptions({ wait: false, batchPath: true })).not.toThrow();
  });

  it('rejects report-file without report', () => {
    expect(() =>
      assertJUnitReportOptions({ reportFile: './out.xml', wait: true, batchPath: true }),
    ).toThrowError(ApiError);
  });

  it('rejects report-suite-name without report', () => {
    expect(() =>
      assertJUnitReportOptions({
        reportSuiteName: 'my-suite',
        wait: true,
        batchPath: true,
      }),
    ).toThrowError(ApiError);
  });

  it('rejects report on non-batch paths', () => {
    expect(() =>
      assertJUnitReportOptions({
        report: 'junit',
        reportFile: './out.xml',
        wait: true,
        batchPath: false,
      }),
    ).toThrowError(ApiError);
  });

  it('rejects report without wait', () => {
    expect(() =>
      assertJUnitReportOptions({
        report: 'junit',
        reportFile: './out.xml',
        wait: false,
        batchPath: true,
      }),
    ).toThrowError(ApiError);
  });

  it('rejects report without report-file', () => {
    expect(() =>
      assertJUnitReportOptions({ report: 'junit', wait: true, batchPath: true }),
    ).toThrowError(ApiError);
  });
});

describe('resolveBatchReportProjectId', () => {
  it('prefers explicit projectId', () => {
    expect(resolveBatchReportProjectId({ projectId: 'proj_a' }, [])).toBe('proj_a');
  });

  it('infers from polled run rows', () => {
    expect(resolveBatchReportProjectId({}, [{ projectId: 'proj_from_run' }])).toBe('proj_from_run');
  });

  it('requires --project when the project cannot be inferred', () => {
    expect(() => resolveBatchReportProjectId({}, [])).toThrowError(ApiError);
    try {
      resolveBatchReportProjectId({}, []);
    } catch (err) {
      expect((err as ApiError).code).toBe('VALIDATION_ERROR');
      expect((err as ApiError).exitCode).toBe(5);
    }
  });
});

describe('buildJUnitReport', () => {
  it('renders an empty suite', () => {
    const xml = buildJUnitReport({
      suiteName: 'Dry suite',
      classname: 'proj_empty',
      results: [],
    });
    expect(xml).toContain(
      '<testsuite name="Dry suite" tests="0" failures="0" errors="0" skipped="0"',
    );
    expect(xml).toContain('</testsuites>');
  });

  it('counts passed tests without child elements', () => {
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [makeResult({ testId: 'test_a', status: 'passed' })],
    });
    // name falls back to the id (no name provided); testId is preserved as an attr.
    expect(xml).toContain('name="test_a" testId="test_a" time="0">');
    expect(xml).not.toContain('<failure');
    expect(xml).toContain('tests="1" failures="0" errors="0"');
  });

  it('renders the human name, preserves the testId attr, and renders the duration', () => {
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({
          testId: 'test_a',
          runId: 'run_a',
          status: 'passed',
          name: 'Login flow works',
          durationSeconds: 12.5,
        }),
      ],
    });
    // A CI test tab shows "Login flow works", not the UUID — the id stays as an attr.
    expect(xml).toContain(
      '<testcase classname="proj_1" name="Login flow works" testId="test_a" runId="run_a" time="12.5">',
    );
    // testsuite time is the sum of testcase durations (was always 0 before).
    expect(xml).toContain('skipped="0" time="12.5">');
  });

  it('falls back to time="0" when the run carries no timing', () => {
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [makeResult({ testId: 'test_a', status: 'passed', name: 'Named' })],
    });
    expect(xml).toContain('name="Named" testId="test_a" time="0">');
  });

  it('maps failed status to failure elements', () => {
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({
          testId: 'test_fail',
          status: 'failed',
          runId: 'run_1',
        }),
      ],
    });
    expect(xml).toContain('<failure message="failed" type="failed">');
    expect(xml).toContain('runId: run_1');
    expect(xml).toContain('failures="1"');
  });

  it('maps blocked and cancelled to failures', () => {
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({ testId: 't_blocked', status: 'blocked' }),
        makeResult({ testId: 't_cancelled', status: 'cancelled' }),
      ],
    });
    expect(xml).toContain('failures="2"');
    expect(xml).toContain('type="blocked"');
    expect(xml).toContain('type="cancelled"');
  });

  it('maps timeout to failure', () => {
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({
          testId: 't_timeout',
          status: 'timeout',
          error: { code: 'UNSUPPORTED', message: 'Timed out', exitCode: 7 },
        }),
      ],
    });
    expect(xml).toContain('<failure message="Timed out" type="timeout">');
  });

  it('maps API error status to error elements', () => {
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({
          testId: 't_err',
          status: 'error',
          error: { code: 'NOT_FOUND', message: 'Run missing', exitCode: 4 },
        }),
      ],
    });
    expect(xml).toContain('<error message="Run missing" type="NOT_FOUND">');
    expect(xml).toContain('errors="1"');
  });

  it('maps auth failures to error elements', () => {
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({
          testId: 't_auth',
          status: 'failed',
          error: { code: 'AUTH_INVALID', message: 'Bad key', exitCode: 3 },
        }),
      ],
    });
    expect(xml).toContain('<error message="Bad key" type="AUTH_INVALID">');
    expect(xml).toContain('failures="0" errors="1"');
  });

  it('escapes special characters in testcase names and messages', () => {
    const xml = buildJUnitReport({
      suiteName: 'Suite "A"',
      classname: 'proj<&>',
      results: [
        makeResult({
          testId: 'test<1>',
          status: 'failed',
          error: { code: 'ASSERT', message: 'expected <true> & "ok"', exitCode: 1 },
        }),
      ],
    });
    expect(xml).toContain('name="test&lt;1&gt;"');
    expect(xml).toContain('classname="proj&lt;&amp;&gt;"');
    expect(xml).toContain('message="expected &lt;true&gt; &amp; &quot;ok&quot;"');
  });

  it('aggregates mixed outcomes', () => {
    const xml = buildJUnitReport({
      suiteName: 'Mixed',
      classname: 'proj_mix',
      results: [
        makeResult({ testId: 'p', status: 'passed' }),
        makeResult({ testId: 'f', status: 'failed' }),
        makeResult({
          testId: 'e',
          status: 'error',
          error: { code: 'INTERNAL', message: 'boom', exitCode: 10 },
        }),
      ],
    });
    expect(xml).toContain('tests="3" failures="1" errors="1" skipped="0"');
  });
});

describe('writeJUnitReportFile', () => {
  it('writes XML atomically to the target path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'junit-report-'));
    const target = join(dir, 'results.xml');
    const xml = buildJUnitReport({
      suiteName: 'Suite',
      classname: 'proj_write',
      results: [makeResult({ testId: 't1', status: 'passed' })],
    });

    await writeJUnitReportFile(target, xml);

    expect(readFileSync(target, 'utf8')).toBe(xml);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a directory target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'junit-report-dir-'));
    await expect(writeJUnitReportFile(dir, '<testsuites/>')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects missing parent directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'junit-report-parent-'));
    const missing = join(dir, 'missing', 'out.xml');
    await expect(writeJUnitReportFile(missing, '<testsuites/>')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('overwrites an existing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'junit-report-overwrite-'));
    const target = join(dir, 'results.xml');
    writeFileSync(target, 'old', 'utf8');
    const xml = buildJUnitReport({
      suiteName: 'New',
      classname: 'proj_new',
      results: [],
    });

    await writeJUnitReportFile(target, xml);

    expect(readFileSync(target, 'utf8')).toBe(xml);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects empty path', async () => {
    await expect(writeJUnitReportFile('', '<testsuites/>')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
    });
  });

  it('rejects parent that is a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'junit-report-file-parent-'));
    const parentFile = join(dir, 'not-a-dir');
    writeFileSync(parentFile, 'x', 'utf8');
    const target = join(parentFile, 'out.xml');
    await expect(writeJUnitReportFile(target, '<testsuites/>')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
