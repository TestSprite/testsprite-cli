import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import {
  assertArtifactPath,
  assertJUnitReportOptions,
  buildJUnitReport,
  durationSecondsBetween,
  escapeXml,
  parseJUnitReportFormat,
  resolveBatchReportProjectId,
  skippedJUnitResultsFromSummary,
  writeJUnitReportFile,
  type JUnitTestResult,
} from './junit-report.js';
import type { CiSummary } from './gh-output.js';

describe('durationSecondsBetween', () => {
  it('computes seconds between two ISO timestamps', () => {
    expect(durationSecondsBetween('2026-08-17T10:00:00.000Z', '2026-08-17T10:00:12.500Z')).toBe(
      12.5,
    );
  });
  it('uses createdAt when startedAt is null', () => {
    expect(
      durationSecondsBetween(null, '2026-08-17T10:00:12.500Z', '2026-08-17T10:00:00.000Z'),
    ).toBe(12.5);
  });

  it('prefers startedAt over createdAt', () => {
    expect(
      durationSecondsBetween(
        '2026-08-17T10:00:05.000Z',
        '2026-08-17T10:00:12.500Z',
        '2026-08-17T10:00:00.000Z',
      ),
    ).toBe(7.5);
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

  it('strips characters that are illegal in XML 1.0', () => {
    expect(escapeXml('boom\x00\x08\x1b')).toBe('boom');
    expect(escapeXml('a\x0bb\x0cc\x0ed\x1ff')).toBe('abcdf');
    expect(escapeXml('x\uFFFEy\uFFFFz')).toBe('xyz');
  });

  it('keeps tab, newline and carriage return, which XML 1.0 allows', () => {
    expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd');
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

  it('#515: disambiguates same-name tests so standard consumers keep both failures', () => {
    // GitLab hashes suite/class/name: two rows sharing classname+name collapse
    // into one row (one failure, one diagnostic). The stable logical testId —
    // not the ephemeral runId — joins the standard identity, for the colliding
    // group only.
    const xml = buildJUnitReport({
      suiteName: 'testsprite:testlist:list-1',
      classname: 'testlist:list-1',
      results: [
        makeResult({
          testId: 'test_a',
          runId: 'run_a',
          status: 'failed',
          name: 'Checkout',
          durationSeconds: 2.5,
        }),
        makeResult({
          testId: 'test_b',
          runId: 'run_b',
          status: 'failed',
          name: 'Checkout',
          durationSeconds: 2.5,
        }),
      ],
    });
    const names = [...xml.matchAll(/<testcase [^>]*? name="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(names).size).toBe(2);
    expect(names).toContain('Checkout [test_a]');
    expect(names).toContain('Checkout [test_b]');
    expect(xml).toContain('<failure message="failed" type="failed">');
    expect((xml.match(/<failure /g) ?? []).length).toBe(2);
  });

  it('#515: keeps unique display names untouched (no suffix noise)', () => {
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({ testId: 'test_a', status: 'passed', name: 'Checkout' }),
        makeResult({ testId: 'test_b', status: 'passed', name: 'Signup' }),
      ],
    });
    expect(xml).toContain('name="Checkout" testId="test_a"');
    expect(xml).toContain('name="Signup" testId="test_b"');
  });

  it('#515: a literal title that matches a suffixed name does not re-collide', () => {
    // "Checkout [case-a]" is also a human title on its own row: after the
    // first suffixing round it must not share its (classname, name) with the
    // suffixed row, or a consumer keyed on classname+name still collapses.
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({ testId: 'case_a', runId: 'run_a', status: 'failed', name: 'Checkout' }),
        makeResult({ testId: 'case_b', runId: 'run_b', status: 'failed', name: 'Checkout' }),
        makeResult({
          testId: 'case_c',
          runId: 'run_c',
          status: 'failed',
          name: 'Checkout [case_a]',
        }),
      ],
    });
    const names = [...xml.matchAll(/<testcase [^>]*? name="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(names).size).toBe(3);
    // Each colliding row keeps its own run's diagnostics.
    expect(xml).toContain('runId: run_a');
    expect(xml).toContain('runId: run_b');
    expect(xml).toContain('runId: run_c');
  });

  it('#515: names that XML attribute normalization folds together still get disambiguated', () => {
    // XML consumers normalize attribute whitespace (CRLF, LF, tabs → spaces),
    // so 'Checkout fix' and 'Checkout\tfix' are the same identity downstream
    // even though the raw strings differ. The resolver must key on the
    // normalized form; rendering keeps the original text.
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({ testId: 'test_a', runId: 'run_a', status: 'failed', name: 'Checkout fix' }),
        makeResult({ testId: 'test_b', runId: 'run_b', status: 'failed', name: 'Checkout\tfix' }),
      ],
    });
    expect(xml).toContain('name="Checkout fix [test_a]"');
    expect(xml).toContain('name="Checkout\tfix [test_b]"');
    expect((xml.match(/<failure /g) ?? []).length).toBe(2);
  });

  it('#515: raw-distinct test ids folded by attribute normalization stay distinct after suffixing', () => {
    // The suffix is written into an XML attribute, so the suffix itself must
    // survive normalization: ids 'a\tb' and 'a b' are raw-distinct but fold
    // to the same attribute identity. A raw suffix would re-collide the pair
    // and the round cap would give up leaving duplicate (classname, name)s;
    // the JSON-escaped suffix keeps the two rows distinct (PR #4652 review).
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({ testId: 'a\tb', runId: 'run_a', status: 'failed', name: 'Checkout' }),
        makeResult({ testId: 'a b', runId: 'run_b', status: 'failed', name: 'Checkout' }),
      ],
    });
    const names = [...xml.matchAll(/<testcase [^>]*? name="([^"]+)"/g)].map(match => match[1]!);
    // Attribute-normalized identities must be pairwise distinct.
    const normalize = (value: string): string =>
      value.replace(/\r\n?/g, '\n').replace(/[\n\t]/g, ' ');
    expect(new Set(names.map(normalize)).size).toBe(2);
    expect(names).toContain('Checkout [a\\tb]');
    expect(names).toContain('Checkout [a b]');
    expect((xml.match(/<failure /g) ?? []).length).toBe(2);
  });

  it('#515: a group whose rows share one testId is left unsuffixed instead of spinning to the cap', () => {
    // testlist run can pass the same id twice, billing each row. Duplicate
    // rows are exact duplicates no suffix can separate, so the resolver must
    // leave them alone rather than re-suffixing until the round cap.
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({
          testId: 'dup',
          runId: 'run_a',
          status: 'failed',
          name: 'Checkout',
          durationSeconds: 1,
        }),
        makeResult({
          testId: 'dup',
          runId: 'run_b',
          status: 'failed',
          name: 'Checkout',
          durationSeconds: 2,
        }),
        makeResult({
          testId: 'dup',
          runId: 'run_c',
          status: 'failed',
          name: 'Checkout',
          durationSeconds: 3,
        }),
      ],
    });
    expect((xml.match(/<failure /g) ?? []).length).toBe(3);
    expect(xml).toContain('name="Checkout" testId="dup"');
    expect(xml).not.toContain('Checkout [');
  });

  it('#515: a mixed duplicate group still disambiguates the distinct ids', () => {
    // Duplicate-id rows keep the group distinct (2 testIds), so the whole
    // group suffixes once; the duplicate pair then reads as a single-distinct
    // group and the loop stops instead of re-suffixing to the cap.
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({ testId: 'dup', runId: 'run_a', status: 'failed', name: 'Checkout' }),
        makeResult({ testId: 'dup', runId: 'run_b', status: 'failed', name: 'Checkout' }),
        makeResult({ testId: 'test_b', runId: 'run_c', status: 'failed', name: 'Checkout' }),
      ],
    });
    expect((xml.match(/<failure /g) ?? []).length).toBe(3);
    expect(xml).toContain('name="Checkout [test_b]"');
    expect((xml.match(/name="Checkout \[dup\]"/g) ?? []).length).toBe(2);
  });

  it('#515: same name under different classnames stays unsuffixed', () => {
    // Distinct classnames are already distinct identities for standard
    // consumers; only rows sharing classname+name need the suffix.
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_default',
      results: [
        makeResult({ testId: 'test_a', status: 'failed', name: 'Checkout', classname: 'proj_one' }),
        makeResult({ testId: 'test_b', status: 'failed', name: 'Checkout', classname: 'proj_two' }),
      ],
    });
    expect(xml).toContain('classname="proj_one" name="Checkout"');
    expect(xml).toContain('classname="proj_two" name="Checkout"');
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

  it('renders an undispatched member with its reason as a skipped testcase', () => {
    const xml = buildJUnitReport({
      suiteName: 'Batch',
      classname: 'proj_1',
      results: [
        makeResult({ testId: 'ran', status: 'passed' }),
        makeResult({
          testId: 'missing',
          status: 'skipped',
          error: { code: 'NOT_DISPATCHED', message: 'not a member of this list (not dispatched)' },
        }),
      ],
    });
    expect(xml).toContain('tests="2" failures="0" errors="0" skipped="1"');
    expect(xml).toContain('testId="missing" time="0">');
    expect(xml).toContain('<skipped message="not a member of this list (not dispatched)"/>');
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

  it('produces a parser-acceptable report when messages carry XML 1.0-illegal characters', () => {
    const xml = buildJUnitReport({
      suiteName: 'Suite\x1bName',
      classname: 'proj_1',
      results: [
        makeResult({
          testId: 'test_bad',
          status: 'failed',
          error: { code: 'ASSERT', message: 'boom\x00\x08\x1b went off', exitCode: 1 },
        }),
      ],
    });
    // A conforming XML 1.0 parser rejects a document containing any of these
    // characters, whether in an attribute value or a text node — the report
    // must contain none of them (the failure element carries the message in
    // both positions) while the readable text survives.
    // eslint-disable-next-line no-control-regex
    expect(xml).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFE\uFFFF]/);
    expect(xml).toContain('name="SuiteName"');
    expect(xml).toContain('message="boom went off"');
    expect(xml).toContain('message: boom went off');
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

describe('skippedJUnitResultsFromSummary', () => {
  const summary: CiSummary = {
    total: 3,
    passed: 1,
    failed: 0,
    skipped: 2,
    timedOut: 0,
    runs: [
      { testId: 'ran', status: 'passed' },
      { testId: 'deferred', status: 'deferred', error: 'deferred: run in flight' },
      // A dispatched run the server later reports under a non-dispatched
      // word. It is already in the polled results, so it must not appear twice.
      { testId: 'ran', status: 'skipped' },
    ],
  };

  it('turns non-dispatched rows into skipped results with their reason', () => {
    expect(skippedJUnitResultsFromSummary(summary)).toEqual([
      { testId: 'deferred', status: 'skipped', skipReason: 'deferred: run in flight' },
      { testId: 'ran', status: 'skipped', skipReason: 'skipped' },
    ]);
  });

  it('leaves out members that are already in the polled results', () => {
    expect(skippedJUnitResultsFromSummary(summary, [{ testId: 'ran' }])).toEqual([
      { testId: 'deferred', status: 'skipped', skipReason: 'deferred: run in flight' },
    ]);
  });
});

describe('per-row classname for batches spanning projects', () => {
  it('uses a row classname over the suite classname', () => {
    const xml = buildJUnitReport({
      suiteName: 's',
      classname: 'suite-class',
      results: [
        { testId: 'a', status: 'passed', classname: 'P1' },
        { testId: 'b', status: 'passed' },
      ],
    });
    expect(xml).toContain('classname="P1" name="a"');
    expect(xml).toContain('classname="suite-class" name="b"');
  });

  it('names the suite from the projects the ids resolved to', () => {
    const one = new Map([['a', 'P1']]);
    const two = new Map([
      ['a', 'P1'],
      ['b', 'P2'],
    ]);
    expect(resolveBatchReportProjectId({ projectIdByTestId: one }, [])).toBe('P1');
    expect(resolveBatchReportProjectId({ projectIdByTestId: two }, [{ projectId: 'P1' }])).toBe(
      'multiple-projects',
    );
    expect(() => resolveBatchReportProjectId({}, [])).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ field: 'project' }) }),
    );
  });
});

describe('assertArtifactPath', () => {
  it('returns the resolved path when the parent directory exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-artifact-'));
    expect(assertArtifactPath('summary-file', join(dir, 'summary.json'))).toBe(
      join(dir, 'summary.json'),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a missing parent directory with the flag name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-artifact-'));
    expect(() => assertArtifactPath('summary-file', join(dir, 'nope', 's.json'))).toThrow(ApiError);
    expect(() => assertArtifactPath('report-file', join(dir, 'nope', 'r.xml'))).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ field: 'report-file' }) }),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports an unreadable target instead of treating it as absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-artifact-'));
    // a <-> b symlink loop: stat fails with ELOOP, which must not pass as "file not created yet"
    symlinkSync(join(dir, 'b'), join(dir, 'a'));
    symlinkSync(join(dir, 'a'), join(dir, 'b'));
    expect(() => assertArtifactPath('report-file', join(dir, 'a'))).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          field: 'report-file',
          reason: expect.stringMatching(/^cannot access .*ELOOP$/),
        }),
      }),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a permission error on the parent instead of "does not exist"',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'cli-artifact-'));
      mkdirSync(join(dir, 'locked', 'out'), { recursive: true });
      chmodSync(join(dir, 'locked'), 0o000);
      try {
        expect(() =>
          assertArtifactPath('summary-file', join(dir, 'locked', 'out', 's.json')),
        ).toThrow(
          expect.objectContaining({
            details: expect.objectContaining({
              field: 'summary-file',
              reason: expect.stringMatching(/^cannot access parent directory .*EACCES$/),
            }),
          }),
        );
      } finally {
        chmodSync(join(dir, 'locked'), 0o755);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('refuses an existing directory as the target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-artifact-'));
    mkdirSync(join(dir, 'sub'));
    expect(() => assertArtifactPath('report-file', join(dir, 'sub'))).toThrow(ApiError);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an empty path', () => {
    expect(() => assertArtifactPath('summary-file', '')).toThrow(ApiError);
  });
});
