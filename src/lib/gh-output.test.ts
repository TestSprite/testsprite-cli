/**
 * Unit tests for the CI-native output layer attached to `test run --all`
 * (issue #99, reshaped from the withdrawn top-level `ci` command). The heavy
 * lifting (trigger + poll) is the batch command's, already covered by its own
 * suites; these tests cover the presentation seams: payload reduction, the
 * job-summary Markdown, and the GitHub gating (env-driven and `--gh-output`
 * forced).
 */

import { describe, expect, it } from 'vitest';
import {
  emitGithubOutputs,
  renderJobSummaryMarkdown,
  summarizeAcceptedPayload,
  summarizeSingleRun,
  type CiSummary,
} from './gh-output.js';

const PAYLOAD = JSON.stringify({
  accepted: [
    {
      testId: 'test_a',
      runId: 'run_a',
      status: 'passed',
      dashboardUrl: 'https://portal.example.com/a',
    },
    {
      testId: 'test_b',
      runId: 'run_b',
      status: 'failed',
      error: { code: 'INTERNAL', message: 'boom', exitCode: 1 },
    },
    { testId: 'test_c', runId: 'run_c', status: 'timeout' },
  ],
  conflicts: [],
});

describe('summarizeAcceptedPayload', () => {
  it('reduces accepted[] rows into counts and rows', () => {
    const summary = summarizeAcceptedPayload(PAYLOAD);
    expect(summary).toMatchObject({ total: 3, passed: 1, failed: 1, timedOut: 1 });
    expect(summary.runs[1]).toMatchObject({ testId: 'test_b', status: 'failed', error: 'boom' });
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
    expect(mixed.runs[0]).toMatchObject({ testId: 'test_ok', status: 'passed' });
  });

  it('folds deferred/conflicts/notFound into non-passed rows — a partial batch is not green', () => {
    const summary = summarizeAcceptedPayload(
      JSON.stringify({
        accepted: [{ testId: 'test_a', runId: 'run_a', status: 'passed' }],
        deferred: [{ testId: 'test_d' }],
        conflicts: [{ testId: 'test_c', currentRunId: 'run_x' }],
        notFound: ['test_nf'],
      }),
    );
    // 1 accepted-passed + 3 not-dispatched → NOT reported as "1/1 passed".
    expect(summary).toMatchObject({ total: 4, passed: 1, timedOut: 0 });
    expect(summary.failed).toBe(3);
    expect(summary.runs.map(r => r.status)).toEqual([
      'passed',
      'deferred',
      'conflict',
      'not_found',
    ]);
    // conflict carries the in-flight runId; each incomplete row explains itself.
    expect(summary.runs[2]).toMatchObject({ testId: 'test_c', runId: 'run_x', status: 'conflict' });
    expect(summary.runs[1]!.error).toContain('deferred');
    expect(summary.runs[3]).toMatchObject({ testId: 'test_nf', status: 'not_found' });
  });

  it('an all-passed batch with empty buckets is unchanged (backward compatible)', () => {
    const summary = summarizeAcceptedPayload(
      JSON.stringify({
        accepted: [{ testId: 'test_a', runId: 'run_a', status: 'passed' }],
        deferred: [],
        conflicts: [],
        notFound: [],
      }),
    );
    expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0, timedOut: 0 });
  });
});

describe('summarizeSingleRun', () => {
  it('reduces a passed single run to a one-row summary', () => {
    const summary = summarizeSingleRun({
      testId: 'test_a',
      runId: 'run_a',
      status: 'passed',
      dashboardUrl: 'https://portal.example.com/a',
      error: null,
    });
    expect(summary).toMatchObject({ total: 1, passed: 1, failed: 0, timedOut: 0 });
    expect(summary.runs).toHaveLength(1);
    expect(summary.runs[0]).toMatchObject({
      testId: 'test_a',
      runId: 'run_a',
      status: 'passed',
      dashboardUrl: 'https://portal.example.com/a',
    });
    expect(summary.runs[0]!.error).toBeUndefined();
  });

  it('carries the raw error string (RunResponse.error is a string, not {message})', () => {
    const summary = summarizeSingleRun({
      testId: 'test_b',
      runId: 'run_b',
      status: 'failed',
      dashboardUrl: null,
      error: 'assertion failed at step 2',
    });
    expect(summary).toMatchObject({ total: 1, passed: 0, failed: 1, timedOut: 0 });
    expect(summary.runs[0]).toMatchObject({ testId: 'test_b', status: 'failed' });
    expect(summary.runs[0]!.error).toBe('assertion failed at step 2');
    expect(summary.runs[0]!.dashboardUrl).toBeUndefined();
  });

  it('omits empty error / null dashboardUrl and defaults a missing status', () => {
    const summary = summarizeSingleRun({ testId: 'test_c', runId: 'run_c', error: '' });
    expect(summary.runs[0]).toMatchObject({ testId: 'test_c', status: 'unknown' });
    expect(summary.runs[0]!.error).toBeUndefined();
    // a non-passed, non-timeout status counts as failed
    expect(summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
  });
});

describe('renderJobSummaryMarkdown', () => {
  it('renders the counts headline and one table row per run', () => {
    const md = renderJobSummaryMarkdown(summarizeAcceptedPayload(PAYLOAD));
    expect(md).toContain('**1/3 passed** (1 failed, 1 timed out)');
    expect(md).toContain('| test_a | passed | [dashboard](https://portal.example.com/a) |');
    expect(md).toContain('| test_c | timeout | run_c |');
  });

  it('escapes cell content so a pipe / newline / paren cannot break or inject table rows', () => {
    const md = renderJobSummaryMarkdown({
      total: 1,
      passed: 0,
      failed: 1,
      timedOut: 0,
      runs: [
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
      timedOut: 0,
      runs: [
        {
          testId: 'evil:id,x',
          runId: 'run_x',
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
