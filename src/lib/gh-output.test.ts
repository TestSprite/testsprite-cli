/**
 * Unit tests for the CI-native output layer attached to `run --project`
 * (issue #99, reshaped from the withdrawn top-level `ci` command). The heavy
 * lifting (trigger + poll) is the batch command's, already covered by its own
 * suites; these tests cover the presentation seams: payload reduction, the
 * job-summary Markdown, and the GitHub gating (env-driven and `--gh-output`
 * forced).
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emitCiArtifacts,
  emitGithubOutputs,
  renderJobSummaryMarkdown,
  reconcileExecutionReportMarkdown,
  summarizeAcceptedPayload,
  summarizeSingleRun,
  type CiSummary,
  emitExecutionReportOutputs,
} from './gh-output.js';

const PAYLOAD = JSON.stringify({
  accepted: [
    {
      testId: 'test_a',
      resultId: 'run_a',
      status: 'passed',
      dashboardUrl: 'https://portal.example.com/a',
    },
    {
      testId: 'test_b',
      resultId: 'run_b',
      status: 'failed',
      error: { code: 'INTERNAL', message: 'boom', exitCode: 1 },
    },
    { testId: 'test_c', resultId: 'run_c', status: 'timeout' },
  ],
  conflicts: [],
});

describe('summarizeAcceptedPayload', () => {
  it('CI keeps a not_found conflict distinct without changing the lower-level default', () => {
    const payload = JSON.stringify({
      accepted: [{ testId: 'a', status: 'passed' }],
      // Always empty on the wire now (every case runs); never folded into rows.
      skippedFrontend: [],
      skippedIntegration: [],
      conflicts: [{ testId: 'gone', reason: 'not_found' }],
    });
    const legacy = summarizeAcceptedPayload(payload);
    expect(legacy).toMatchObject({ total: 2, passed: 1, skipped: 1 });
    expect(legacy.results[1]!.status).toBe('conflict');
    const ci = summarizeAcceptedPayload(payload, { foldSkippedBuckets: true });
    expect(ci).toMatchObject({ total: 2, passed: 1, failed: 0, skipped: 1 });
    expect(ci.results[1]!.status).toBe('not_found');
    expect(ci.results.map(row => row.testId)).toEqual(['a', 'gone']);
  });

  it('CI annotations carry the actual conflict reason and actionable message', () => {
    const summary = summarizeAcceptedPayload(
      JSON.stringify({
        conflicts: [{ testId: 'local', reason: 'local_address', message: 'Choose a public URL' }],
      }),
      { foldSkippedBuckets: true },
    );
    expect(summary.results[0]!.error).toBe('Choose a public URL (not dispatched)');
    expect(summary).toMatchObject({ total: 1, failed: 0, skipped: 1 });
  });

  it('reduces accepted[] rows into counts and rows', () => {
    const summary = summarizeAcceptedPayload(PAYLOAD);
    expect(summary).toMatchObject({ total: 3, passed: 1, failed: 1, timedOut: 1 });
    expect(summary.results[1]).toMatchObject({ testId: 'test_b', status: 'failed', error: 'boom' });
  });

  it('unparseable or non-batch output reduces to an empty summary (never throws)', () => {
    expect(summarizeAcceptedPayload('')).toMatchObject({ total: 0, passed: 0 });
    expect(summarizeAcceptedPayload('{"method":"POST"}')).toMatchObject({ total: 0 });
    expect(summarizeAcceptedPayload('not json')).toMatchObject({ total: 0 });
  });

  it('valid-JSON non-record payloads and null rows are skipped, not crashes', () => {
    expect(summarizeAcceptedPayload('null')).toMatchObject({ total: 0 });
    expect(summarizeAcceptedPayload('"a string"')).toMatchObject({ total: 0 });
    expect(summarizeAcceptedPayload('[1,2]')).toMatchObject({ total: 0 });
    const mixed = summarizeAcceptedPayload(
      JSON.stringify({ accepted: [null, 42, { testId: 'test_ok', status: 'passed' }] }),
    );
    expect(mixed.total).toBe(1);
    expect(mixed.results[0]).toMatchObject({ testId: 'test_ok', status: 'passed' });
  });

  it('folds deferred/conflicts/notFound into non-passed rows — a partial batch is not green', () => {
    const summary = summarizeAcceptedPayload(
      JSON.stringify({
        accepted: [{ testId: 'test_a', resultId: 'run_a', status: 'passed' }],
        deferred: [{ testId: 'test_d' }],
        conflicts: [{ testId: 'test_c', currentResultId: 'run_x' }],
        notFound: ['test_nf'],
      }),
    );
    // 1 accepted-passed + 3 not-dispatched → NOT reported as "1/1 passed",
    // but the never-dispatched rows count as `skipped`, not `failed`:
    // nothing ran and failed, and a `failed` count the exit-code gates disagree
    // with is exactly the summary-contradicts-the-exit bug.
    expect(summary).toMatchObject({ total: 4, passed: 1, timedOut: 0 });
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(3);
    expect(summary.results.map(r => r.status)).toEqual([
      'passed',
      'deferred',
      'conflict',
      'not_found',
    ]);
    // conflict carries the in-flight runId; each incomplete row explains itself.
    expect(summary.results[2]).toMatchObject({
      testId: 'test_c',
      resultId: 'run_x',
      status: 'conflict',
    });
    expect(summary.results[1]!.error).toContain('deferred');
    expect(summary.results[3]).toMatchObject({ testId: 'test_nf', status: 'not_found' });
  });

  it('an all-passed batch with empty buckets is unchanged (backward compatible)', () => {
    const summary = summarizeAcceptedPayload(
      JSON.stringify({
        accepted: [{ testId: 'test_a', resultId: 'run_a', status: 'passed' }],
        deferred: [],
        conflicts: [],
        notFound: [],
      }),
    );
    expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0, skipped: 0, timedOut: 0 });
  });

  it('a mixed batch keeps `failed` for dispatched non-passes only (measured repro shape)', () => {
    // The ticket's reproduction: test_1 accepted+passed, test_2 conflicted.
    // The artifact must not claim `failed: 1` while the batch's own summary
    // (and possibly the exit code) says nothing failed.
    const summary = summarizeAcceptedPayload(
      JSON.stringify({
        accepted: [{ testId: 'test_1', resultId: 'run_1', status: 'passed' }],
        conflicts: [{ testId: 'test_2', currentResultId: 'run_2' }],
      }),
    );
    expect(summary).toMatchObject({ total: 2, passed: 1, failed: 0, skipped: 1, timedOut: 0 });
  });
});

describe('summarizeSingleRun', () => {
  it('reduces a passed single run to a one-row summary', () => {
    const summary = summarizeSingleRun({
      testId: 'test_a',
      resultId: 'run_a',
      status: 'passed',
      dashboardUrl: 'https://portal.example.com/a',
      error: null,
    });
    expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0, timedOut: 0 });
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toMatchObject({
      testId: 'test_a',
      resultId: 'run_a',
      status: 'passed',
      dashboardUrl: 'https://portal.example.com/a',
    });
    expect(summary.results[0]!.error).toBeUndefined();
  });

  it('carries the raw error string (RunResponse.error is a string, not {message})', () => {
    const summary = summarizeSingleRun({
      testId: 'test_b',
      resultId: 'run_b',
      status: 'failed',
      dashboardUrl: null,
      error: 'assertion failed at step 2',
    });
    expect(summary).toMatchObject({ total: 1, passed: 0, failed: 1, timedOut: 0 });
    expect(summary.results[0]).toMatchObject({ testId: 'test_b', status: 'failed' });
    expect(summary.results[0]!.error).toBe('assertion failed at step 2');
    expect(summary.results[0]!.dashboardUrl).toBeUndefined();
  });

  it('omits empty error / null dashboardUrl and defaults a missing status', () => {
    const summary = summarizeSingleRun({ testId: 'test_c', resultId: 'run_c', error: '' });
    expect(summary.results[0]).toMatchObject({ testId: 'test_c', status: 'unknown' });
    expect(summary.results[0]!.error).toBeUndefined();
    // An unknown verdict is still a gate error.
    expect(summary).toMatchObject({ total: 1, passed: 0, failed: 0, errors: 1 });
  });
});

describe('renderJobSummaryMarkdown', () => {
  it('renders the counts headline and one table row per run', () => {
    const md = renderJobSummaryMarkdown(summarizeAcceptedPayload(PAYLOAD));
    expect(md).toContain('**1/3 passed** (1 failed, 0 skipped, 1 timed out)');
    // test_a has dashboardUrl but no executionUrl: the title (id fallback) links
    // to the test-case page; the Result cell shows the raw result id (no link).
    expect(md).toContain('| [test_a](https://portal.example.com/a) | passed | run_a |');
    expect(md).toContain('| test_c | timeout | run_c |');
  });

  it('escapes cell content so a pipe / newline / paren cannot break or inject table rows', () => {
    const md = renderJobSummaryMarkdown({
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      timedOut: 0,
      results: [
        {
          testId: 'evil|id\n✅ fake passed',
          status: 'failed',
          dashboardUrl: 'https://x.example.com/a(b)c',
        },
      ],
    });
    // The whole run renders as exactly ONE table row (no injected lines).
    const rowLines = md.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| ---'));
    // header row + the single data row
    expect(rowLines).toHaveLength(2);
    const dataRow = rowLines[1]!;
    expect(dataRow).not.toContain('\n');
    expect(dataRow).toContain('evil\\|id'); // pipe escaped
    expect(dataRow).not.toContain('✅ fake passed\n'); // newline neutralized to a space
    expect(dataRow).toContain('%28b%29'); // parens in the URL percent-encoded
  });
});

describe('emitGithubOutputs', () => {
  const summary: CiSummary = summarizeAcceptedPayload(PAYLOAD);

  function makeSinks() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const appended: Array<{ path: string; content: string }> = [];
    return {
      stdout,
      stderr,
      appended,
      sinks: {
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
        appendFile: (path: string, content: string) => appended.push({ path, content }),
      },
    };
  }

  it('appends the job summary and annotates only non-passed runs under Actions', () => {
    const { stdout, appended, sinks } = makeSinks();
    emitGithubOutputs(
      summary,
      { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: '/gh/summary.md' },
      sinks,
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]!.path).toBe('/gh/summary.md');
    expect(appended[0]!.content).toContain('TestSprite results');
    const annotations = stdout.filter(line => line.startsWith('::error'));
    expect(annotations).toHaveLength(2);
    expect(annotations[0]).toContain('test_b');
    expect(annotations[0]).toContain('boom');
    expect(annotations[1]).toContain('test_c');
  });

  it('never-dispatched rows annotate as ::warning::, dispatched failures as ::error::', () => {
    const { stdout, sinks } = makeSinks();
    const mixed = summarizeAcceptedPayload(
      JSON.stringify({
        accepted: [
          { testId: 'test_pass', runId: 'r1', status: 'passed' },
          { testId: 'test_fail', runId: 'r2', status: 'failed' },
        ],
        conflicts: [{ testId: 'test_conf', currentResultId: 'r3' }],
        notFound: ['test_nf'],
        deferred: [{ testId: 'test_def' }],
      }),
    );
    emitGithubOutputs(mixed, { GITHUB_ACTIONS: 'true' }, sinks);
    // A red ::error:: on a green job is the checks-tab half of the same
    // contradiction — only the genuinely-failed run may carry it.
    const errors = stdout.filter(line => line.startsWith('::error'));
    const warnings = stdout.filter(line => line.startsWith('::warning'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('test_fail');
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toContain('test_conf');
    expect(warnings.join('\n')).toContain('test_nf');
    expect(warnings.join('\n')).toContain('test_def');
  });

  it('emits nothing off-CI, and a broken summary file downgrades to stderr', () => {
    const offCi = makeSinks();
    emitGithubOutputs(summary, {}, offCi.sinks);
    expect(offCi.stdout).toHaveLength(0);
    expect(offCi.appended).toHaveLength(0);

    const broken = makeSinks();
    emitGithubOutputs(
      summary,
      { GITHUB_STEP_SUMMARY: '/gh/summary.md' },
      {
        ...broken.sinks,
        appendFile: () => {
          throw new Error('EROFS');
        },
      },
    );
    expect(broken.stderr.join('\n')).toContain('could not append');
    // The failure message names the command via the `label` opt (default 'run').
    // Pin BOTH directions so reverting the `[${label}]` template to a hardcoded
    // `[run]` can't pass silently: default is `[run]`, and a caller-supplied
    // label appears verbatim.
    expect(broken.stderr.join('\n')).toContain('[run]');
    const labeled = makeSinks();
    emitGithubOutputs(
      summary,
      { GITHUB_STEP_SUMMARY: '/gh/summary.md' },
      {
        ...labeled.sinks,
        appendFile: () => {
          throw new Error('EROFS');
        },
      },
      { label: 'run --testlist' },
    );
    expect(labeled.stderr.join('\n')).toContain('[run --testlist]');
  });

  it('force (--gh-output) emits annotations off-Actions; the step summary still needs its env path', () => {
    const forced = makeSinks();
    emitGithubOutputs(summary, {}, forced.sinks, { force: true });
    const annotations = forced.stdout.filter(line => line.startsWith('::error'));
    expect(annotations).toHaveLength(2);
    expect(forced.appended).toHaveLength(0);
  });

  it('escapes raw errors and ids so a run error cannot inject a second workflow command', () => {
    const { stdout, sinks } = makeSinks();
    const malicious: CiSummary = {
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      timedOut: 0,
      results: [
        {
          testId: 'evil:id,x',
          resultId: 'run_x',
          status: 'failed',
          error: 'line1\n::add-mask::supersecret\n::stop-commands::abc',
        },
      ],
    };
    emitGithubOutputs(malicious, { GITHUB_ACTIONS: 'true' }, sinks);
    // One annotate() call → one array element; the invariant that neutralizes
    // the injection is that the string carries NO raw newline (so the embedded
    // ::add-mask:: / ::stop-commands:: sit mid-line, where Actions does not
    // parse them as commands) — the newline is percent-encoded instead.
    expect(stdout).toHaveLength(1);
    const line = stdout[0]!;
    expect(line.startsWith('::error')).toBe(true);
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    expect((line.match(/%0A/g) ?? []).length).toBe(2); // both newlines encoded
    // testId ':' and ',' are property-escaped in the title.
    expect(line).toContain('title=TestSprite evil%3Aid%2Cx::');
  });

  it('a dedicated annotations sink diverts workflow commands off the primary stdout', () => {
    const { stdout, sinks } = makeSinks();
    const diverted: string[] = [];
    emitGithubOutputs(
      summary,
      { GITHUB_ACTIONS: 'true' },
      { ...sinks, annotations: line => diverted.push(line) },
    );
    expect(stdout).toHaveLength(0);
    expect(diverted.filter(line => line.startsWith('::error'))).toHaveLength(2);
  });
});

// The shared chokepoint four commands funnel through. Its two guard branches
// (summary-file-without-gh-output, and the complete no-op) are otherwise pinned
// by no command's suite, so exercise them directly against real temp files.
describe('emitCiArtifacts', () => {
  const summary: CiSummary = summarizeAcceptedPayload(PAYLOAD);

  it('--summary-file only (no --gh-output, off Actions): writes the file, emits no annotations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-emitci-file-'));
    const summaryFile = join(dir, 'summary.json');
    const stdout: string[] = [];
    const stderr: string[] = [];
    emitCiArtifacts(
      summary,
      { summaryFile },
      { env: {}, stdout: l => stdout.push(l), stderr: l => stderr.push(l) },
      'run',
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this test's own mkdtempSync temp file, never user input.
    const artifact = JSON.parse(readFileSync(summaryFile, 'utf8')) as CiSummary;
    expect(artifact.total).toBe(summary.total);
    // Off Actions and no --gh-output ⇒ the machine artifact is written but no
    // ::error:: annotations are emitted.
    expect(stdout.some(l => l.startsWith('::error'))).toBe(false);
    expect(stderr).toHaveLength(0);
  });

  it('neither --gh-output nor --summary-file, off Actions: complete no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-emitci-noop-'));
    const summaryFile = join(dir, 'should-not-exist.json');
    const stdout: string[] = [];
    const stderr: string[] = [];
    emitCiArtifacts(
      summary,
      {},
      { env: {}, stdout: l => stdout.push(l), stderr: l => stderr.push(l) },
      'run',
    );
    expect(stdout).toHaveLength(0);
    expect(stderr).toHaveLength(0);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checks this test's own mkdtempSync temp path, never user input.
    expect(existsSync(summaryFile)).toBe(false);
  });

  it('the label names the command in BOTH failure messages (summary-file write + step-summary append)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-emitci-label-'));
    // A path whose parent directory does not exist makes the real writeFileSync /
    // appendFileSync throw synchronously, exercising both best-effort catch paths.
    const badSummary = join(dir, 'missing', 'summary.json');
    const badStep = join(dir, 'missing', 'step-summary.md');
    const stderr: string[] = [];
    emitCiArtifacts(
      summary,
      { ghOutput: true, summaryFile: badSummary },
      { env: { GITHUB_STEP_SUMMARY: badStep }, stdout: () => {}, stderr: l => stderr.push(l) },
      'run --testlist',
    );
    const out = stderr.join('\n');
    expect(out).toContain('[run --testlist] could not write --summary-file');
    expect(out).toContain('[run --testlist] could not append');
  });
});

describe('test title in CI output', () => {
  it('summarizeAcceptedPayload maps testTitle → row.title (batch)', () => {
    const s = summarizeAcceptedPayload(
      JSON.stringify({
        accepted: [
          {
            testId: 't-1',
            testTitle: 'Sign in from the login page',
            runId: 'r-1',
            status: 'passed',
          },
        ],
      }),
    );
    expect(s.results[0]).toMatchObject({ testId: 't-1', title: 'Sign in from the login page' });
  });

  it('summarizeSingleRun maps testTitle → row.title, and null leaves it absent', () => {
    expect(
      summarizeSingleRun({ testId: 't', testTitle: 'Login', status: 'passed' }).results[0],
    ).toMatchObject({
      title: 'Login',
    });
    // A null title (older server) → no title key → renderer falls back to the id.
    expect(
      summarizeSingleRun({ testId: 't', testTitle: null, status: 'passed' }).results[0]!.title,
    ).toBeUndefined();
  });

  it('renderJobSummaryMarkdown shows the title in the Test column, falling back to the id', () => {
    const md = renderJobSummaryMarkdown({
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
      timedOut: 0,
      results: [
        { testId: 't-1', title: 'Sign in from the login page', status: 'passed', resultId: 'r-1' },
        { testId: 't-2', status: 'passed', resultId: 'r-2' }, // no title → id
      ],
    });
    expect(md).toContain('| Sign in from the login page | passed | r-1 |');
    expect(md).toContain('| t-2 | passed | r-2 |');
  });

  it('a title with a pipe / newline cannot break the table row', () => {
    const md = renderJobSummaryMarkdown({
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      timedOut: 0,
      results: [{ testId: 't', title: 'evil|title\nfake', status: 'failed', resultId: 'r' }],
    });
    const rows = md.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| ---'));
    expect(rows).toHaveLength(2); // header + one data row, no injected line
    expect(rows[1]!).toContain('evil\\|title'); // pipe escaped
  });

  it('an empty / whitespace-only title falls back to the id (parity with JUnit)', () => {
    const md = renderJobSummaryMarkdown({
      total: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
      timedOut: 0,
      results: [
        { testId: 't-1', title: '', status: 'passed', resultId: 'r-1' },
        { testId: 't-2', title: '   ', status: 'passed', resultId: 'r-2' },
      ],
    });
    expect(md).toContain('| t-1 | passed | r-1 |');
    expect(md).toContain('| t-2 | passed | r-2 |');
  });

  it('renders the title into the ::error annotation, escaped, id fallback when empty', () => {
    const stdout: string[] = [];
    const sinks = { stdout: (l: string) => stdout.push(l), stderr: () => {}, appendFile: () => {} };
    emitGithubOutputs(
      {
        total: 2,
        passed: 0,
        failed: 2,
        skipped: 0,
        timedOut: 0,
        results: [
          { testId: 't-1', title: 'Sign in\nnow', status: 'failed', resultId: 'r-1' },
          { testId: 't-2', title: '  ', status: 'failed', resultId: 'r-2' },
        ],
      },
      {},
      sinks,
      { force: true },
    );
    const anns = stdout.filter(l => l.startsWith('::error'));
    // Title used (not the id), and its newline is escaped — can't inject a command.
    expect(anns[0]).toContain('TestSprite Sign in%0Anow');
    expect(anns[0]).not.toContain('\n:: ');
    // Empty title → id fallback in the annotation too.
    expect(anns[1]).toContain('TestSprite t-2');
  });
});

describe('run-scoped execution link in CI output', () => {
  it('summarizeAcceptedPayload maps executionUrl → row.executionUrl (batch)', () => {
    const summary = summarizeAcceptedPayload(
      JSON.stringify({
        accepted: [
          {
            testId: 't1',
            runId: 'r1',
            status: 'passed',
            dashboardUrl: 'https://portal.example.com/case/t1',
            executionUrl: 'https://portal.example.com/exec/e1',
          },
        ],
        conflicts: [],
      }),
    );
    expect(summary.results[0]!.executionUrl).toBe('https://portal.example.com/exec/e1');
  });

  it('summarizeSingleRun maps executionUrl → row.executionUrl (absent when null)', () => {
    expect(
      summarizeSingleRun({ testId: 't1', status: 'passed', executionUrl: 'https://x/exec/e1' })
        .results[0]!.executionUrl,
    ).toBe('https://x/exec/e1');
    expect(
      summarizeSingleRun({ testId: 't1', status: 'passed', executionUrl: null }).results[0]!
        .executionUrl,
    ).toBeUndefined();
  });

  it('renders two distinct links: title → test-case page, Result → the result page', () => {
    const md = renderJobSummaryMarkdown({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      timedOut: 0,
      results: [
        {
          testId: 't1',
          title: 'Sign in',
          status: 'passed',
          resultId: 'r1',
          dashboardUrl: 'https://portal.example.com/case/t1',
          executionUrl: 'https://portal.example.com/exec/e1',
        },
      ],
    });
    expect(md).toContain(
      '| [Sign in](https://portal.example.com/case/t1) | passed | [r1](https://portal.example.com/exec/e1) |',
    );
  });

  it('a bracketed title in link position cannot retarget the link (]/[ escaped)', () => {
    const md = renderJobSummaryMarkdown({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      timedOut: 0,
      results: [
        {
          testId: 't1',
          // A `]` would close the markdown link early and point the visible title
          // at the injected URL — realistic for an LLM-authored title.
          title: 'x](https://evil.example) y',
          status: 'passed',
          resultId: 'r1',
          dashboardUrl: 'https://portal.example.com/case/t1',
        },
      ],
    });
    const dataRow = md.split('\n').find(l => l.startsWith('| ['))!;
    // The `]` is backslash-escaped, so GFM treats it as literal text: the link
    // text runs to the REAL closing `](portal-url)`, not the injected one. (The
    // link-text escaper touches brackets only — parens stay as inert text.)
    expect(dataRow).toContain('[x\\](https://evil.example) y](https://portal.example.com/case/t1)');
  });

  it('a backslash before the bracket cannot defeat the escape (backslash escaped first)', () => {
    const md = renderJobSummaryMarkdown({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      timedOut: 0,
      results: [
        {
          testId: 't1',
          // The title's own `\` would consume the escape we insert before `]`,
          // re-exposing the bracket — unless backslashes are doubled first.
          title: 'a\\](https://evil.example) y',
          status: 'passed',
          resultId: 'r1',
          dashboardUrl: 'https://portal.example.com/case/t1',
        },
      ],
    });
    const dataRow = md.split('\n').find(l => l.startsWith('| ['))!;
    // Value's `\` doubled → `\\` (literal backslash) then `\]` (literal bracket):
    // the link text survives to the REAL portal close, evil URL is inert text.
    expect(dataRow).toContain(
      '[a\\\\\\](https://evil.example) y](https://portal.example.com/case/t1)',
    );
  });

  it('a backslash before a pipe cannot break the column (plain cell, backslash escaped first)', () => {
    const md = renderJobSummaryMarkdown({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      timedOut: 0,
      // Plain (unlinked) cell — no dashboardUrl — exercises escapeTableCell alone.
      results: [{ testId: 'a\\|b', status: 'passed', resultId: 'r1' }],
    });
    const rows = md.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| ---'));
    // Header + exactly one data row: the `\|` did NOT open a fourth column.
    expect(rows).toHaveLength(2);
    // `\\` (literal backslash) + `\|` (literal pipe), not an unescaped separator.
    expect(rows[1]!).toContain('a\\\\\\|b');
  });

  it('no executionUrl (V2 run): the Result cell degrades to the raw result id, title still links', () => {
    const md = renderJobSummaryMarkdown({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      timedOut: 0,
      results: [
        {
          testId: 't1',
          title: 'Sign in',
          status: 'passed',
          resultId: 'r1',
          dashboardUrl: 'https://portal.example.com/case/t1',
        },
      ],
    });
    expect(md).toContain('| [Sign in](https://portal.example.com/case/t1) | passed | r1 |');
  });

  it('annotation link prefers the execution result page over the test-case page', () => {
    const stdout: string[] = [];
    const sinks = { stdout: (l: string) => stdout.push(l), stderr: () => {}, appendFile: () => {} };
    emitGithubOutputs(
      {
        total: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        timedOut: 0,
        results: [
          {
            testId: 't1',
            title: 'Sign in',
            status: 'failed',
            resultId: 'r1',
            dashboardUrl: 'https://portal.example.com/case/t1',
            executionUrl: 'https://portal.example.com/exec/e1',
          },
        ],
      },
      {},
      sinks,
      { force: true },
    );
    const ann = stdout.find(l => l.startsWith('::error'))!;
    expect(ann).toContain('https://portal.example.com/exec/e1');
    expect(ann).not.toContain('/case/t1');
  });
});

describe('environment batch skips', () => {
  it('counts skipped backend IDs alongside accepted runs', () => {
    const summary = summarizeAcceptedPayload(
      JSON.stringify({
        accepted: [{ testId: 'a', runId: 'r', status: 'passed' }],
        skipped: [{ testId: 'b', reason: 'backend-test' }],
      }),
    );
    expect(summary).toMatchObject({ total: 2, passed: 1, skipped: 1, failed: 0 });
    expect(summary.results).toContainEqual({
      testId: 'b',
      status: 'skipped',
      error: 'backend-test',
    });
  });
});

describe('emitGithubOutputs — server-rendered markdown', () => {
  const summary: CiSummary = summarizeAcceptedPayload(PAYLOAD);

  it('writes the given markdown to the step summary instead of the local table', () => {
    const appended: { path: string; content: string }[] = [];
    emitGithubOutputs(
      summary,
      { GITHUB_STEP_SUMMARY: '/tmp/step.md' },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        appendFile: (path, content) => appended.push({ path, content }),
      },
      { markdown: '> [!TIP]\n> ### All checks passed\n' },
    );
    expect(appended).toEqual([
      { path: '/tmp/step.md', content: '> [!TIP]\n> ### All checks passed\n' },
    ]);
  });

  it('without markdown the local table is written, byte-identical to before', () => {
    const appended: { path: string; content: string }[] = [];
    emitGithubOutputs(
      summary,
      { GITHUB_STEP_SUMMARY: '/tmp/step.md' },
      {
        stdout: () => undefined,
        stderr: () => undefined,
        appendFile: (path, content) => appended.push({ path, content }),
      },
    );
    expect(appended[0]?.content).toContain('## TestSprite results');
  });
});

describe('emitExecutionReportOutputs', () => {
  const ready = {
    report: {
      projectId: 'p',
      runId: 'exec/1',
      projectName: 'Shop',
      orgId: null,
      stats: { passed: 1, failed: 0, blocked: 0, total: 1 },
      allPassed: true,
      narrative: null,
      whatCouldBeBetter: null,
      recommendedNextStep: null,
      tests: [],
      resultUrl: 'https://portal.example.com/x',
    },
    markdown: '# report\n',
  };

  it('shows an execution cancellation alongside passing results in both job summaries', () => {
    const summary = summarizeSingleRun({ runId: 'aborted', resultId: 'r1', status: 'passed' });
    summary.runFailures = [
      { runId: 'aborted', status: 'cancelled', message: 'Cancelled.\n# note' },
    ];
    for (const md of [
      renderJobSummaryMarkdown(summary),
      reconcileExecutionReportMarkdown(summary, ready),
    ]) {
      expect(md).toContain('> Run `aborted` — cancelled: `Cancelled.# note`');
      expect(md).not.toContain('\n# note');
    }
    expect(reconcileExecutionReportMarkdown(summary, ready)).toContain('> [!WARNING]');
  });

  it('writes both files under RUNNER_TEMP and names them in GITHUB_OUTPUT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-exec-report-'));
    const outputPath = join(dir, 'outputs');
    const stderr: string[] = [];
    const written = emitExecutionReportOutputs(ready, {
      env: { GITHUB_OUTPUT: outputPath, RUNNER_TEMP: dir },
      stderr: l => stderr.push(l),
    });
    // The launch id is sanitised into a file name; the real id stays in the
    // JSON, under the name the CLI prints it by.
    expect(written).toEqual({
      jsonPath: join(dir, 'testsprite-execution-report-exec_1.json'),
      markdownPath: join(dir, 'testsprite-execution-report-exec_1.md'),
    });
    const { runId, ...rest } = ready.report;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this test's own mkdtempSync files.
    const writtenJson = readFileSync(written!.jsonPath, 'utf8');
    expect(JSON.parse(writtenJson)).toEqual({ ...rest, runId });
    expect(writtenJson).not.toContain('xecutionId');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this test's own mkdtempSync files.
    expect(readFileSync(written!.markdownPath, 'utf8')).toBe('# report\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this test's own mkdtempSync files.
    expect(readFileSync(outputPath, 'utf8')).toBe(
      `execution-report-file=${written!.jsonPath}\nexecution-report-markdown-file=${written!.markdownPath}\n`,
    );
    expect(stderr).toHaveLength(0);
  });

  it('is a no-op without GITHUB_OUTPUT (nothing downstream can read the paths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-exec-report-noop-'));
    const stderr: string[] = [];
    expect(
      emitExecutionReportOutputs(ready, { env: { RUNNER_TEMP: dir }, stderr: l => stderr.push(l) }),
    ).toBeUndefined();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checks this test's own mkdtempSync path.
    expect(existsSync(join(dir, 'testsprite-execution-report-exec_1.md'))).toBe(false);
  });

  it('reports a write failure on stderr and returns nothing, never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-exec-report-fail-'));
    const stderr: string[] = [];
    expect(
      emitExecutionReportOutputs(ready, {
        env: { GITHUB_OUTPUT: join(dir, 'outputs'), RUNNER_TEMP: join(dir, 'missing') },
        stderr: l => stderr.push(l),
      }),
    ).toBeUndefined();
    expect(stderr).toEqual([expect.stringContaining('execution report files not written')]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checks this test's own mkdtempSync path.
    expect(existsSync(join(dir, 'outputs'))).toBe(false);
  });
});

// Inside the CLI a summary row keeps the wire names: `runId` is one test's
// result and `executionId` the launch it belongs to. What is written out
// calls them `resultId` and `runId`.
describe('the launch and the result in CI output', () => {
  const BATCH = JSON.stringify({
    accepted: [
      { testId: 'A', resultId: 'r1', runId: 'e1', status: 'passed' },
      { testId: 'B', resultId: 'r2', runId: 'e1', status: 'failed' },
    ],
    conflicts: [{ testId: 'C', currentResultId: 'r9', currentRunId: 'e9', reason: 'in_flight' }],
  });

  it('a batch row keeps the launch it was dispatched under; a conflict row the launch holding the test', () => {
    const { results } = summarizeAcceptedPayload(BATCH);
    expect(results.map(({ testId, resultId, runId }) => ({ testId, resultId, runId }))).toEqual([
      { testId: 'A', resultId: 'r1', runId: 'e1' },
      { testId: 'B', resultId: 'r2', runId: 'e1' },
      { testId: 'C', resultId: 'r9', runId: 'e9' },
    ]);
  });

  it('a single run keeps its launch', () =>
    expect(
      summarizeSingleRun({ testId: 'A', resultId: 'r1', runId: 'e1', status: 'passed' }).results,
    ).toEqual([{ testId: 'A', resultId: 'r1', runId: 'e1', status: 'passed' }]));

  it('an old server: rows carry no launch', () => {
    const { results } = summarizeAcceptedPayload(
      JSON.stringify({
        accepted: [{ testId: 'A', resultId: 'r1', status: 'passed' }],
        conflicts: [{ testId: 'C', currentResultId: 'r9', reason: 'in_flight' }],
      }),
    );
    expect(results.some(row => 'executionId' in row)).toBe(false);
    expect(
      'executionId' in
        summarizeSingleRun({ testId: 'A', resultId: 'r1', status: 'passed' }).results[0]!,
    ).toBe(false);
  });

  it('the job summary names the launch once and lists each test under Result', () => {
    const md = renderJobSummaryMarkdown(summarizeAcceptedPayload(BATCH));
    expect(md).toContain('\nRun `e1`\n');
    expect(md).toContain('| Test | Status | Result |');
    expect(md).toContain('| A | passed | r1 |');
    // The launch holding a test this run did not dispatch is not this run.
    expect(md).not.toContain('e9');
  });

  it('several launches are all named', () =>
    expect(
      renderJobSummaryMarkdown(
        summarizeAcceptedPayload(
          JSON.stringify({
            accepted: [
              { testId: 'A', resultId: 'r1', runId: 'e1', status: 'passed' },
              { testId: 'B', resultId: 'r2', runId: 'e2', status: 'passed' },
            ],
          }),
        ),
      ),
    ).toContain('\nRuns `e1`, `e2`\n'));

  it('an old server: the job summary has no Run line', () => {
    const md = renderJobSummaryMarkdown(
      summarizeSingleRun({ testId: 'A', resultId: 'r1', status: 'passed' }),
    );
    expect(md).not.toMatch(/^Runs? `/m);
    expect(md).toContain('| A | passed | r1 |');
  });

  it('a launch id cannot break out of its code span', () =>
    expect(
      renderJobSummaryMarkdown(
        summarizeSingleRun({ testId: 'A', resultId: 'r1', runId: 'e`1\n# x', status: 'passed' }),
      ),
    ).toContain('\nRun `e1# x`\n'));
});
