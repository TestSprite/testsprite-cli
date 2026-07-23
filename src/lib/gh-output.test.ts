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
});

describe('renderJobSummaryMarkdown', () => {
  it('renders the counts headline and one table row per run', () => {
    const md = renderJobSummaryMarkdown(summarizeAcceptedPayload(PAYLOAD));
    expect(md).toContain('**1/3 passed** (1 failed, 1 timed out)');
    expect(md).toContain('| test_a | passed | [dashboard](https://portal.example.com/a) |');
    expect(md).toContain('| test_c | timeout | run_c |');
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
