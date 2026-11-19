/**
 * Unit tests for `result list` and `result get`.
 *
 * A run is one launch (`runId`); a result is one test's part of it
 * (`resultId`). All HTTP is a scripted fetch behind the real command tree,
 * mounted under a program carrying the global flags `src/index.ts` registers.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRY_RUN_BANNER, resetDryRunBannerForTesting } from '../lib/client-factory.js';
import { ApiError, CLIError, InterruptError } from '../lib/errors.js';
import { globalShutdown } from '../lib/interrupt.js';
import type { ResultDetail, ResultLine, ResultList, ResultStep } from '../lib/result/types.js';
import { resultListAnswer } from '../../test/helpers/result-list.js';
import { createResultCommand } from './result.js';

const ENV = {
  TESTSPRITE_API_KEY: 'sk-user-result-spec',
  TESTSPRITE_API_URL: 'https://api.example.com',
};

const line = (resultId: string, more: Partial<ResultLine> = {}): ResultLine => ({
  resultId,
  runId: 'e1',
  caseKey: 'test_1',
  title: `Test ${resultId}`,
  testStatus: 'FAILED',
  processStatus: 'Idle',
  error: 'The confirmation heading never appeared.',
  blockedReason: null,
  environmentName: 'staging',
  created: '2026-11-10T08:00:00.000Z',
  ...more,
});

const step = (stepIndex: string, status: ResultStep['status']): ResultStep => ({
  stepIndex,
  type: 'action',
  action: 'click',
  description: `Step ${stepIndex} of the checkout`,
  status,
  selector: '#submit',
  url: 'https://staging.example.com/checkout',
  healed: false,
  screenshotSignedUrl: `https://storage.example.com/steps/${stepIndex}.png`,
  htmlSignedUrl: `https://storage.example.com/steps/${stepIndex}.html`,
});

/** A frontend result as an older backend sends it: without `trace` and `apiOutput`. */
const DETAIL: ResultDetail = {
  resultId: 'r1',
  runId: 'e1',
  caseKey: 'test_1',
  caseHash: 'hash_1',
  title: 'Checkout shows the order confirmation',
  type: 'frontend',
  testStatus: 'FAILED',
  processStatus: 'Idle',
  processErrorMessage: null,
  error: 'The confirmation heading never appeared.',
  cause: 'The submit button stayed disabled.',
  fix: 'Enable the button once the form validates.',
  blockedReason: null,
  videoUrl: 'https://storage.example.com/video/r1.mp4',
  envId: 'env_1',
  created: '2026-11-10T08:00:00.000Z',
  modified: '2026-11-10T08:01:00.000Z',
  failedStep: step('2', 'failed'),
  steps: [step('1', 'passed'), step('2', 'failed')],
  signIn: null,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** How the backend answers an id it looked up and did not find in the caller's workspace. */
const notFound = (resource: string, id: string): Response =>
  json(
    {
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found.',
        nextAction:
          'Check the id with the corresponding `list` command, e.g. `testsprite test list --project <id>`.',
        requestId: 'req_404',
        details: { resource, id },
      },
    },
    404,
  );

/** How a server without the route answers: Nest's own 404 body, naming no resource. */
const noSuchRoute = (): Response =>
  json({ message: 'Cannot GET /api/cli/v1/results/r1', error: 'Not Found', statusCode: 404 }, 404);

type Backend = (url: URL) => Response;

/** The run `e1` holds `r1` (failed) and `r2` (passed); test `test_1` has `r1` and an older `r0`. */
const backend: Backend = url => {
  const path = url.pathname.replace('/api/cli/v1', '');
  if (path === '/results') {
    const run = url.searchParams.get('run');
    const test = url.searchParams.get('test');
    if (run !== null) {
      if (run !== 'e1') return notFound('run', run);
      return json(
        resultListAnswer(
          [line('r1'), line('r2', { testStatus: 'PASSED', error: null, caseKey: 'test_2' })],
          url.searchParams,
        ),
      );
    }
    if (test !== 'test_1') return notFound('test', String(test));
    const history = resultListAnswer(
      [line('r1'), line('r0', { runId: 'e0', testStatus: 'PASSED', error: null })],
      url.searchParams,
    );
    const limit = Number(url.searchParams.get('limit') ?? 20);
    return json({
      ...history,
      results: history.results.slice(0, limit),
      hiddenRunCount: 0,
      retentionDays: 30,
    });
  }
  if (path === '/results/r1') return json(DETAIL);
  const id = decodeURIComponent(path.slice('/results/'.length));
  return notFound('result', id);
};

function harness(answer: Backend = backend) {
  const calls: URL[] = [];
  const fetchImpl = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    return answer(url);
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command()
    .option('--output <mode>')
    .option('--dry-run')
    .option('--profile <name>')
    .option('--endpoint-url <url>')
    .option('--request-timeout <seconds>')
    .option('--debug')
    .option('--verbose');
  program.addCommand(
    createResultCommand({
      env: ENV,
      fetchImpl,
      stdout: text => stdout.push(text),
      stderr: text => stderr.push(text),
    }),
  );
  // A parse error throws instead of ending the test process.
  const throwOnParseError = (command: Command): void => {
    command.exitOverride().configureOutput({ writeErr: () => {} });
    command.commands.forEach(throwOnParseError);
  };
  throwOnParseError(program);
  return {
    calls,
    fetchImpl,
    stdout,
    stderr,
    run: (...args: string[]) => program.parseAsync(args, { from: 'user' }),
    /** The error the command ends with; fails when it ends without one. */
    fails: async (...args: string[]): Promise<CLIError> => {
      try {
        await program.parseAsync(args, { from: 'user' });
      } catch (err) {
        if (err instanceof CLIError) return err;
        throw err;
      }
      throw new Error(`expected \`${args.join(' ')}\` to fail`);
    },
  };
}

beforeEach(() => {
  resetDryRunBannerForTesting();
});

describe('result list', () => {
  it('distinguishes queued and executing results in text and preserves their wire statuses in JSON', async () => {
    const results = ['Idle', 'Executing', null].map((processStatus, i) =>
      line(`r${i}`, { testStatus: 'RUNNING', processStatus, error: null }),
    );
    const answer: Backend = url => json(resultListAnswer(results, url.searchParams));
    const args = ['result', 'list', '--run', 'e1', '--status', 'running'];
    const text = harness(answer);
    await text.run(...args);
    expect(text.stdout.join('\n')).toMatch(/\sQUEUED\s+r0\s/);
    expect(text.stdout.join('\n')).toMatch(/\sRUNNING\s+r1\s/);
    expect(text.stdout.join('\n')).toMatch(/\sRUNNING\s+r2\s/);

    const asJson = harness(answer);
    await asJson.run('--output', 'json', ...args);
    expect(JSON.parse(asJson.stdout.join('\n'))).toEqual({ results });
  });

  it('result list --run <id> --status failed asks for failed only and prints one line per result', async () => {
    const h = harness();
    await h.run('result', 'list', '--run', 'e1', '--status', 'failed');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.pathname).toBe('/api/cli/v1/results');
    expect(Object.fromEntries(h.calls[0]!.searchParams)).toEqual({ run: 'e1', status: 'failed' });
    const lines = h.stdout.join('\n').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^CREATED\s+STATUS\s+RESULT ID\s+RUN ID\s+ENV\s+TITLE$/);
    expect(lines[1]).toMatch(/^2026-11-10T08:00:00\.000Z\s+FAILED\s+r1\s+e1\s+staging\s+Test r1$/);
  });

  it('result list --test <id> --status --env --limit forwards every filter and prints one line', async () => {
    const h = harness();
    await h.run(
      'result',
      'list',
      '--test',
      'test_1',
      '--status',
      'Failed,cancelled',
      '--env',
      'staging',
      '--limit',
      '1',
    );
    expect(Object.fromEntries(h.calls[0]!.searchParams)).toEqual({
      test: 'test_1',
      status: 'failed,cancelled',
      environment: 'staging',
      limit: '1',
    });
    const lines = h.stdout.join('\n').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/\sr1\s+e1\s/);
  });

  it('result list with neither --test nor --run exits 5; with both exits 5', async () => {
    const h = harness();
    const neither = await h.fails('result', 'list');
    expect(neither.exitCode).toBe(5);
    expect((neither as ApiError).nextAction).toMatch(/--test <test-id>.*--run <run-id>/);
    const both = await h.fails('result', 'list', '--test', 'test_1', '--run', 'e1');
    expect(both.exitCode).toBe(5);
    expect((both as ApiError).nextAction).toContain('--test and --run');
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['--test', ''],
    ['--test', '  '],
    ['--run', ''],
  ])('an empty %s value exits 5 before any request', async (flag, value) => {
    const h = harness();
    const err = await h.fails('result', 'list', flag, value);
    expect(err.exitCode).toBe(5);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([[''], ['  ']])('an empty --env %j exits 5 before any request', async value => {
    const h = harness();
    const err = await h.fails('result', 'list', '--test', 'test_1', '--env', value);
    expect(err.exitCode).toBe(5);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('--limit takes 1 to 100, both ends included', async () => {
    for (const limit of ['1', '100']) {
      const h = harness();
      await h.run('result', 'list', '--test', 'test_1', '--limit', limit);
      expect(h.calls[0]!.searchParams.get('limit')).toBe(limit);
    }
  });

  it('--status names each status once, however often it is given', async () => {
    const h = harness();
    await h.run('result', 'list', '--run', 'e1', '--status', 'failed', '--status', 'FAILED,failed');
    expect(h.calls[0]!.searchParams.get('status')).toBe('failed');
  });

  it('--status is comma-separated, repeatable and case-insensitive', async () => {
    const h = harness();
    await h.run(
      'result',
      'list',
      '--run',
      'e1',
      '--status',
      'Failed, PASSED',
      '--status',
      'cancelled',
    );
    expect(h.calls[0]!.searchParams.get('status')).toBe('failed,passed,cancelled');
  });

  it('without --status sends no status: the server leaves cancelled results out', async () => {
    const h = harness();
    await h.run('result', 'list', '--run', 'e1');
    expect(h.calls[0]!.searchParams.has('status')).toBe(false);
  });

  it.each([['flaky'], ['failed,queued'], [','], ['']])(
    '--status %j exits 5 naming the statuses it takes, before any request',
    async value => {
      const h = harness();
      const err = await h.fails('result', 'list', '--run', 'e1', '--status', value);
      expect(err.exitCode).toBe(5);
      expect((err as ApiError).nextAction).toContain('passed, failed, running, blocked, cancelled');
      expect(h.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([['0'], ['101'], ['abc'], ['1.5'], ['1e1'], ['-1']])(
    '--limit %s exits 5 before any request',
    async value => {
      const h = harness();
      const err = await h.fails('result', 'list', '--test', 'test_1', '--limit', value);
      expect(err.exitCode).toBe(5);
      expect((err as ApiError).nextAction).toContain('1 to 100');
      expect(h.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['--env', 'staging'],
    ['--limit', '5'],
  ])('%s with --run exits 5 and says it needs --test', async (flag, value) => {
    const h = harness();
    const err = await h.fails('result', 'list', '--run', 'e1', flag, value);
    expect(err.exitCode).toBe(5);
    expect((err as ApiError).nextAction).toContain(`${flag} only applies with --test`);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('a read exits 0 whatever the verdicts it lists', async () => {
    const h = harness();
    await expect(h.run('result', 'list', '--run', 'e1')).resolves.toBeDefined();
    expect(h.stdout.join('\n')).toContain('FAILED');
  });

  it('prints the wire list as it is in JSON', async () => {
    const h = harness();
    await h.run('--output', 'json', 'result', 'list', '--test', 'test_1');
    const printed = JSON.parse(h.stdout.join('\n')) as ResultList;
    expect(printed).toEqual({
      results: [line('r1'), line('r0', { runId: 'e0', testStatus: 'PASSED', error: null })],
      hiddenRunCount: 0,
      retentionDays: 30,
    });
  });

  describe('a test that has never run', () => {
    const neverRun: Backend = () => json({ results: [], hiddenRunCount: 0, retentionDays: 30 });

    it('says there are no results and exits 0', async () => {
      const h = harness(neverRun);
      await h.run('result', 'list', '--test', 'test_new');
      expect(h.stdout).toEqual(['No results.']);
    });

    it('says on stderr, as a possibility, that cancelled results are left out, when no --status was given', async () => {
      const h = harness(neverRun);
      await h.run('result', 'list', '--test', 'test_new');
      expect(h.stderr).toEqual([
        'If its results were cancelled, list them with --status cancelled.',
      ]);
    });

    it("gives only the plan window's explanation when the window hides the test's results", async () => {
      const h = harness(() => json({ results: [], hiddenRunCount: 2, retentionDays: 30 }));
      await h.run('result', 'list', '--test', 'test_old');
      expect(h.stdout).toEqual(['No results.']);
      expect(h.stderr).toHaveLength(1);
      expect(h.stderr[0]).not.toMatch(/cancelled/);
    });

    it('says nothing more when --status was given, or in JSON', async () => {
      const filtered = harness(neverRun);
      await filtered.run('result', 'list', '--test', 'test_new', '--status', 'failed');
      expect(filtered.stdout).toEqual(['No results.']);
      expect(filtered.stderr).toEqual([]);
      const asJson = harness(neverRun);
      await asJson.run('--output', 'json', 'result', 'list', '--test', 'test_new');
      expect(asJson.stderr).toEqual([]);
    });

    it('prints the empty list in JSON', async () => {
      const h = harness(neverRun);
      await h.run('--output', 'json', 'result', 'list', '--test', 'test_new');
      expect(JSON.parse(h.stdout.join('\n'))).toEqual({
        results: [],
        hiddenRunCount: 0,
        retentionDays: 30,
      });
    });
  });

  describe("the plan's history window", () => {
    const hidden: Backend = () =>
      json({ results: [line('r1')], hiddenRunCount: 3, retentionDays: 30 });

    it("says on stderr how many of a test's results the plan holds back", async () => {
      const h = harness(hidden);
      await h.run('result', 'list', '--test', 'test_1');
      expect(h.stdout.join('\n')).not.toContain('hidden');
      expect(h.stderr.join('\n')).toContain(
        '3 older results hidden — your plan keeps 30 days of run history.',
      );
    });

    it('says it under an empty history too', async () => {
      const h = harness(() => json({ results: [], hiddenRunCount: 1, retentionDays: 7 }));
      await h.run('result', 'list', '--test', 'test_1');
      expect(h.stdout).toEqual(['No results.']);
      expect(h.stderr.join('\n')).toContain('1 older result hidden — your plan keeps 7 days');
    });

    it('never says it for a run, even when the response carries the fields', async () => {
      const h = harness(hidden);
      await h.run('result', 'list', '--run', 'e1');
      expect(h.stderr.join('\n')).not.toContain('hidden');
    });

    it('leaves it out of JSON stderr: the document carries the fields', async () => {
      const h = harness(hidden);
      await h.run('--output', 'json', 'result', 'list', '--test', 'test_1');
      expect(h.stderr).toEqual([]);
      expect(JSON.parse(h.stdout.join('\n'))).toMatchObject({ hiddenRunCount: 3 });
    });
  });
});

describe('result get', () => {
  it('heads a queued result with its queue status and includes the server process status', async () => {
    const h = harness(() => json({ ...DETAIL, testStatus: 'RUNNING', processStatus: 'Idle' }));
    await h.run('result', 'get', 'r1');
    const lines = h.stdout.join('\n').split('\n');
    expect(lines[0]).toBe(`QUEUED  ${DETAIL.title}`);
    expect(lines).toContain('processStatus:  Idle');
  });

  it('result get <id> prints the failed step in text and all steps in json', async () => {
    const text = harness();
    await text.run('result', 'get', 'r1');
    expect(text.calls.map(url => url.pathname)).toEqual(['/api/cli/v1/results/r1']);
    const printed = text.stdout.join('\n');
    expect(printed.split('\n')[0]).toBe('FAILED  Checkout shows the order confirmation');
    expect(printed).toContain('failedStep:     2  Step 2 of the checkout');
    expect(printed).toContain('https://storage.example.com/steps/2.png');
    expect(printed).not.toContain('Step 1 of the checkout');
    expect(printed).toContain('steps:          2 (1 failed)');

    const asJson = harness();
    await asJson.run('--output', 'json', 'result', 'get', 'r1');
    expect(JSON.parse(asJson.stdout.join('\n'))).toEqual(DETAIL);
  });

  it('a read exits 0 whatever the verdict', async () => {
    const h = harness();
    await expect(h.run('result', 'get', 'r1')).resolves.toBeDefined();
  });

  it.each([[''], ['  ']])('a blank <result-id> %j exits 5 before any request', async value => {
    const h = harness();
    const err = await h.fails('result', 'get', value);
    expect(err.exitCode).toBe(5);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('--failed-only without --out exits 5', async () => {
    const h = harness();
    const err = await h.fails('result', 'get', 'r1', '--failed-only');
    expect(err.exitCode).toBe(5);
    expect((err as ApiError).nextAction).toContain('--failed-only only applies with --out');
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  describe('a backend test', () => {
    const traceLines = Array.from({ length: 25 }, (_, i) => `trace ${i + 1}`);
    const BACKEND: ResultDetail = {
      ...DETAIL,
      type: 'BACKEND',
      videoUrl: null,
      failedStep: null,
      steps: [],
      trace: traceLines.join('\n'),
      apiOutput: 'POST /orders\nstatus 500',
    };

    it('prints its traceback, cut to the last 20 lines, and its output in text', async () => {
      const h = harness(() => json(BACKEND));
      await h.run('result', 'get', 'r1');
      const printed = h.stdout.join('\n').split('\n');
      expect(printed.slice(printed.indexOf('trace:'))).toEqual([
        'trace:',
        '  (5 earlier lines: --output json, or --out <dir> for result.json)',
        ...traceLines.slice(5).map(line => `  ${line}`),
        'apiOutput:',
        '  POST /orders',
        '  status 500',
      ]);
    });

    it('prints both whole in JSON, as the server sent them', async () => {
      const h = harness(() => json(BACKEND));
      await h.run('--output', 'json', 'result', 'get', 'r1');
      expect(JSON.parse(h.stdout.join('\n'))).toEqual(BACKEND);
    });

    it('from an older backend that sends neither, prints neither, and JSON has no such keys', async () => {
      const text = harness();
      await text.run('result', 'get', 'r1');
      const printed = text.stdout.join('\n');
      expect(printed).not.toMatch(/^(trace|apiOutput):/m);
      expect(printed.split('\n').at(-1)).toBe(
        'videoUrl:       https://storage.example.com/video/r1.mp4',
      );

      const asJson = harness();
      await asJson.run('--output', 'json', 'result', 'get', 'r1');
      const parsed = JSON.parse(asJson.stdout.join('\n'));
      expect(parsed).not.toHaveProperty('trace');
      expect(parsed).not.toHaveProperty('apiOutput');
    });
  });
});

describe('result get --out', () => {
  let parent: string;
  let dir: string;
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'result-get-out-'));
    dir = join(parent, 'evidence');
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  /** The backend, and storage answering each signed link with its path, or the status `failing` names. */
  const withStorage =
    (failing: Record<string, number> = {}): Backend =>
    url => {
      if (url.hostname !== 'storage.example.com') return backend(url);
      const status = failing[url.pathname];
      return status === undefined
        ? new Response(`bytes of ${url.pathname}`)
        : new Response('Forbidden', { status });
    };

  /** Every file under `root` with its content, keyed by its path relative to `root`. */
  const contentsOf = (root: string): Record<string, string> =>
    Object.fromEntries(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => {
          const path = join(entry.parentPath, entry.name);
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
          return [relative(root, path), readFileSync(path, 'utf8')];
        }),
    );

  const storageCalls = (h: ReturnType<typeof harness>) =>
    h.fetchImpl.mock.calls.filter(([input]) => String(input).includes('storage.example.com'));

  it('keeps downloaded snapshots out of Git on the first export in a new repository', async () => {
    execFileSync('git', ['init', '--quiet'], { cwd: parent });
    const output = join(parent, '.testsprite', 'results', 'r1');
    await harness(withStorage()).run('result', 'get', 'r1', '--out', output);
    const files = ['steps/002.html', 'video.mp4', 'result.json'];
    expect(
      execFileSync('git', ['check-ignore', '--', ...files], { cwd: output, encoding: 'utf8' })
        .trim()
        .split('\n'),
    ).toEqual(files);
    expect(
      execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: parent, encoding: 'utf8' }),
    ).toBe('');
  });

  it('preserves custom ignore rules and warns about evidence in a repository', async () => {
    execFileSync('git', ['init', '--quiet'], { cwd: parent });
    const state = join(parent, '.testsprite');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside this test's temporary repository.
    mkdirSync(state);
    const custom = join(state, '.gitignore');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside this test's temporary repository.
    writeFileSync(custom, 'agent.json\n');
    for (const destination of [join(state, 'results', 'r1'), dir]) {
      const h = harness(withStorage());
      await h.run('--output', 'json', 'result', 'get', 'r1', '--out', destination);
      expect(h.stderr.join(' ')).toMatch(/credentials/i);
      expect(JSON.parse(h.stdout.join('')).written).toContain('steps/002.html');
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside this test's temporary repository.
    expect(readFileSync(custom, 'utf8')).toBe('agent.json\n');
  });

  it('writes the evidence and prints what it wrote', async () => {
    const h = harness(withStorage());
    await h.run('result', 'get', 'r1', '--out', dir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
    expect(readFileSync(join(dir, 'steps', '002.png'), 'utf8')).toBe('bytes of /steps/2.png');
    expect(h.stdout.join('\n')).toBe(
      [
        `Wrote 5 evidence files, and result.json, to ${dir}`,
        '  video.mp4',
        '  steps/001.png',
        '  steps/001.html',
        '  steps/002.png',
        '  steps/002.html',
        '  result.json',
      ].join('\n'),
    );
    expect(h.stderr).toEqual([]);
  });

  it('prints the directory and the files written in JSON', async () => {
    const h = harness(withStorage());
    await h.run('--output', 'json', 'result', 'get', 'r1', '--out', dir);
    expect(JSON.parse(h.stdout.join('\n'))).toEqual({
      dir,
      written: [
        'video.mp4',
        'steps/001.png',
        'steps/001.html',
        'steps/002.png',
        'steps/002.html',
        'result.json',
      ],
      failed: [],
    });
  });

  it('downloads with the bare fetch: the API key goes to the API only', async () => {
    const h = harness(withStorage());
    await h.run('result', 'get', 'r1', '--out', dir);
    const [api] = h.fetchImpl.mock.calls.filter(([input]) =>
      String(input).includes('/api/cli/v1/'),
    );
    expect(new Headers(api![1]?.headers).has('x-api-key')).toBe(true);
    expect(storageCalls(h)).toHaveLength(5);
    for (const [, init] of storageCalls(h)) {
      expect(new Headers(init?.headers).has('x-api-key')).toBe(false);
    }
  });

  it('--out exits non-zero and lists the files that failed', async () => {
    const h = harness(withStorage({ '/steps/2.png': 403 }));
    const err = await h.fails('--output', 'json', 'result', 'get', 'r1', '--out', dir);
    // A download that did not complete is UNAVAILABLE, as it always was.
    expect(err.exitCode).toBe(10);
    expect(err.code).toBe('UNAVAILABLE');
    // Five evidence files were planned; result.json is not one of them.
    expect(err.message).toBe('1 of 5 evidence files could not be downloaded.');
    expect((err as ApiError).nextAction).toBe(
      "Run testsprite result get r1 --out <dir> again: each read signs new links. See each file's reason above.",
    );
    expect((err as ApiError).details).toEqual({
      failed: [{ file: 'steps/002.png', reason: expect.stringContaining('HTTP 403') }],
    });
    // The download follows the one read; nothing is read again.
    expect(h.calls.filter(url => url.hostname === 'api.example.com')).toHaveLength(1);
    expect(JSON.parse(h.stdout.join('\n'))).toEqual({
      dir,
      written: ['video.mp4', 'steps/001.png', 'steps/001.html', 'steps/002.html', 'result.json'],
      failed: [{ file: 'steps/002.png', reason: expect.stringContaining('HTTP 403') }],
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
    expect(existsSync(join(dir, 'result.json'))).toBe(true);
  });

  it("keeps a backend test's traceback and output in result.json as the server sent them", async () => {
    const backend = { ...DETAIL, trace: 'Traceback\nAssertionError', apiOutput: 'status 500\n' };
    const storage = withStorage();
    const h = harness(url => (url.pathname.endsWith('/results/r1') ? json(backend) : storage(url)));
    await h.run('result', 'get', 'r1', '--out', dir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
    const written = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as ResultDetail;
    expect(written).toMatchObject({ trace: backend.trace, apiOutput: backend.apiOutput });

    const older = join(parent, 'older');
    await harness(withStorage()).run('result', 'get', 'r1', '--out', older);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
    const olderWritten = JSON.parse(readFileSync(join(older, 'result.json'), 'utf8')) as object;
    expect(olderWritten).not.toHaveProperty('trace');
    expect(olderWritten).not.toHaveProperty('apiOutput');
  });

  it('lists the files that failed in text', async () => {
    const h = harness(withStorage({ '/steps/2.png': 403 }));
    await h.fails('result', 'get', 'r1', '--out', dir);
    const printed = h.stdout.join('\n').split('\n');
    // One unit on both streams: the same 1 of 5 evidence files the error counts.
    expect(printed[0]).toBe(`Wrote 4 of 5 evidence files, and result.json, to ${dir}`);
    expect(printed.slice(-2)).toEqual([
      'Not downloaded:',
      '  steps/002.png  Failed to download presigned URL (HTTP 403).',
    ]);
  });

  it('--failed-only downloads the failed step and its neighbours, and keeps every step in result.json', async () => {
    const fourSteps = { ...DETAIL, steps: [...DETAIL.steps, step('3', null), step('4', null)] };
    const storage = withStorage();
    const h = harness(url =>
      url.pathname.endsWith('/results/r1') ? json(fourSteps) : storage(url),
    );
    await h.run('--output', 'json', 'result', 'get', 'r1', '--out', dir, '--failed-only');
    // Step 2 failed: steps 1 to 3 are its window, step 4 is not.
    expect(JSON.parse(h.stdout.join('\n')).written).toEqual([
      'video.mp4',
      'steps/001.png',
      'steps/001.html',
      'steps/002.png',
      'steps/002.html',
      'steps/003.png',
      'steps/003.html',
      'result.json',
    ]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
    const written = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as ResultDetail;
    expect(written.steps).toHaveLength(4);
    expect(written.steps[3]).toMatchObject({ screenshotSignedUrl: null, htmlSignedUrl: null });
  });

  it('--failed-only with no failed step downloads every step, and says so on stderr in text', async () => {
    const passed: ResultDetail = {
      ...DETAIL,
      testStatus: 'PASSED',
      failedStep: null,
      steps: DETAIL.steps.map(s => ({ ...s, status: 'passed' as const })),
    };
    const storage = withStorage();
    const answer: Backend = url =>
      url.pathname.endsWith('/results/r1') ? json(passed) : storage(url);

    const text = harness(answer);
    await text.run('result', 'get', 'r1', '--out', dir, '--failed-only');
    expect(text.stdout.join('\n')).toContain('  steps/001.png');
    expect(text.stderr).toEqual(['No failed step; downloaded every step.']);

    const asJson = harness(answer);
    await asJson.run('--output', 'json', 'result', 'get', 'r1', '--out', dir, '--failed-only');
    expect(JSON.parse(asJson.stdout.join('\n')).written).toContain('steps/001.png');
    expect(asJson.stderr).toEqual([]);

    // A result with a failed step gets no such note.
    const failed = harness(withStorage());
    await failed.run('result', 'get', 'r1', '--out', dir, '--failed-only');
    expect(failed.stderr).toEqual([]);

    // Nor does a plain --out, which narrows nothing.
    const plain = harness(answer);
    await plain.run('result', 'get', 'r1', '--out', dir);
    expect(plain.stderr).toEqual([]);
  });

  it('--failed-only with sign-in steps only, none failed, prints the note', async () => {
    const signedIn: ResultDetail = {
      ...DETAIL,
      testStatus: 'BLOCKED',
      failedStep: null,
      steps: [],
      signIn: {
        id: 'fa_1',
        status: 'passed',
        videoUrl: null,
        finalUrl: 'https://staging.example.com/home',
        stepCount: 1,
        error: null,
        steps: [step('1', 'passed')],
      },
    };
    const storage = withStorage();
    const h = harness(url =>
      url.pathname.endsWith('/results/r1') ? json(signedIn) : storage(url),
    );
    await h.run('result', 'get', 'r1', '--out', dir, '--failed-only');
    expect(h.stdout.join('\n')).toContain('  sign-in/steps/001.png');
    expect(h.stderr).toEqual(['No failed step; downloaded every step.']);
  });

  it('--failed-only on a result with no steps at all prints no note', async () => {
    const neverRan: ResultDetail = { ...DETAIL, failedStep: null, steps: [], signIn: null };
    const storage = withStorage();
    const h = harness(url =>
      url.pathname.endsWith('/results/r1') ? json(neverRan) : storage(url),
    );
    await h.run('result', 'get', 'r1', '--out', dir, '--failed-only');
    expect(h.stdout.join('\n')).toContain('  video.mp4');
    expect(h.stderr).toEqual([]);
  });

  it('a Ctrl-C mid-download, seen through the process signal, leaves the earlier download as it was', async () => {
    await harness(withStorage()).run('result', 'get', 'r1', '--out', dir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    const before = contentsOf(dir);

    // The signal handler aborts the process signal; the fetch in flight then
    // fails as an aborted fetch does, with no InterruptError of its own.
    const controller = new AbortController();
    const signal = vi.spyOn(globalShutdown, 'signal', 'get').mockReturnValue(controller.signal);
    try {
      const storage = withStorage();
      const h = harness(url => {
        if (url.pathname === '/steps/1.png') {
          controller.abort(new InterruptError('SIGINT'));
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return storage(url);
      });
      const err = await h.fails('result', 'get', 'r1', '--out', dir);
      expect(err).toBeInstanceOf(InterruptError);
      expect(contentsOf(dir)).toEqual(before);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
      expect(readdirSync(dir).filter(entry => entry.startsWith('.testsprite-partial-'))).toEqual(
        [],
      );
    } finally {
      signal.mockRestore();
    }
  });

  it('an --out that is a file exits 5 before any request', async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
    writeFileSync(dir, 'a file');
    const h = harness(withStorage());
    const err = await h.fails('result', 'get', 'r1', '--out', dir);
    expect(err.exitCode).toBe(5);
    expect((err as ApiError).nextAction).toContain('must point to a directory');
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('an --out under a file exits 5 before any request', async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
    writeFileSync(dir, 'a file');
    const h = harness(withStorage());
    const err = await h.fails('result', 'get', 'r1', '--out', join(dir, 'below'));
    expect(err.exitCode).toBe(5);
    expect((err as ApiError).nextAction).toContain('parent path is not a directory');
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('an empty --out exits 5 before any request', async () => {
    const h = harness(withStorage());
    const err = await h.fails('result', 'get', 'r1', '--out', '');
    expect(err.exitCode).toBe(5);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('a result the server does not know writes nothing', async () => {
    const h = harness(withStorage());
    const err = await h.fails('result', 'get', 'r_missing', '--out', dir);
    expect(err.exitCode).toBe(4);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
    expect(existsSync(dir)).toBe(false);
  });

  it('--dry-run reads the sample, downloads nothing and writes nothing', async () => {
    const h = harness(withStorage());
    await h.run('--dry-run', 'result', 'get', 'r1', '--out', dir);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this spec's own mkdtemp dir.
    expect(existsSync(dir)).toBe(false);
    const printed = h.stdout.join('\n').split('\n');
    expect(printed[0]).toBe(`Would write 7 evidence files, and result.json, to ${dir}`);
    expect(printed).toContain('  steps/003.png');
    expect(printed.at(-1)).toBe('  result.json');
  });

  it('--dry-run --failed-only previews only the files the download would write', async () => {
    const h = harness(withStorage());
    await h.run('--dry-run', 'result', 'get', 'r1', '--out', dir, '--failed-only');
    // The sample's third step failed: steps 2 and 3 are its window.
    expect(h.stdout.join('\n').split('\n')).toEqual([
      `Would write 5 evidence files, and result.json, to ${dir}`,
      '  video.mp4',
      '  steps/002.png',
      '  steps/002.html',
      '  steps/003.png',
      '  steps/003.html',
      '  result.json',
    ]);
    expect(h.stderr).toEqual([DRY_RUN_BANNER]);
  });

  it('--dry-run prints the plan under the keys a download prints', async () => {
    const h = harness(withStorage());
    await h.run('--dry-run', '--output', 'json', 'result', 'get', 'r1', '--out', dir);
    const printed = JSON.parse(h.stdout.join('\n')) as Record<string, unknown>;
    expect(Object.keys(printed)).toEqual(['dir', 'written', 'failed']);
    expect(printed).toMatchObject({ dir, failed: [] });
  });
});

describe('--dry-run', () => {
  it.each([
    [['result', 'list', '--run', 'e1']],
    [['result', 'list', '--test', 'test_1', '--status', 'failed', '--env', 'qa', '--limit', '3']],
    [['result', 'get', 'r1']],
  ])('--dry-run makes no request: %j', async args => {
    const h = harness();
    await h.run('--dry-run', ...args);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.stderr[0]).toBe(DRY_RUN_BANNER);
    expect(h.stdout.join('\n').length).toBeGreaterThan(0);
  });

  it('result list --run --dry-run prints the sample run, and never the history window', async () => {
    const h = harness();
    await h.run('--dry-run', 'result', 'list', '--run', 'e1');
    const printed = h.stdout.join('\n');
    expect(printed).toContain('run_dryrun0001');
    expect(printed.split('\n')).toHaveLength(5);
    expect(h.stderr.join('\n')).not.toContain('hidden');
  });

  it("result list --test --dry-run prints the sample with the plan's window", async () => {
    const h = harness();
    await h.run('--dry-run', 'result', 'list', '--test', 'test_1');
    expect(h.stderr.join('\n')).toContain('4 older results hidden');
  });

  it('result list --dry-run --output json carries the history window for a test only', async () => {
    const run = harness();
    await run.run('--dry-run', '--output', 'json', 'result', 'list', '--run', 'e1');
    const runList = JSON.parse(run.stdout.join('\n')) as ResultList;
    expect(runList.results.length).toBeGreaterThan(0);
    expect(runList).not.toHaveProperty('hiddenRunCount');
    expect(runList).not.toHaveProperty('retentionDays');
    resetDryRunBannerForTesting();
    const test = harness();
    await test.run('--dry-run', '--output', 'json', 'result', 'list', '--test', 'test_1');
    expect(JSON.parse(test.stdout.join('\n'))).toMatchObject({
      hiddenRunCount: 4,
      retentionDays: 30,
    });
  });

  it('result get --dry-run prints the sample failed result', async () => {
    const h = harness();
    await h.run('--dry-run', '--output', 'json', 'result', 'get', 'r1');
    expect(JSON.parse(h.stdout.join('\n'))).toMatchObject({
      testStatus: 'FAILED',
      failedStep: { status: 'failed' },
    });
  });

  it('validates before anything else, so a dry run with a bad flag still exits 5', async () => {
    const h = harness();
    const err = await h.fails('--dry-run', 'result', 'list', '--run', 'e1', '--limit', '3');
    expect(err.exitCode).toBe(5);
    expect(h.stderr).toEqual([]);
  });
});

describe('an id the server does not know', () => {
  it.each([
    [['result', 'get', 'r_missing'], 'result', 'r_missing'],
    [['result', 'list', '--run', 'e_missing'], 'run', 'e_missing'],
    [['result', 'list', '--test', 'test_missing'], 'test', 'test_missing'],
  ])('a 404 preserves the raw server envelope and exit code: %j', async (args, resource, id) => {
    const h = harness();
    const err = await h.fails(...args);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.exitCode).toBe(4);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Resource not found.');
    expect((err as ApiError).details).toEqual({ resource, id });
    expect((err as ApiError).requestId).toBe('req_404');
  });

  it('preserves the server nextAction for missing results and executions', async () => {
    const h = harness();
    const original = ApiError.fromEnvelope(
      await notFound('result', 'r_missing').json(),
      404,
    ).nextAction;
    const result = (await h.fails('result', 'get', 'r_missing')) as ApiError;
    const run = (await h.fails('result', 'list', '--run', 'e_missing')) as ApiError;
    expect(result.nextAction).toBe(original);
    expect(run.nextAction).toBe(original);
  });

  it('a server without the route is not reported as a missing result: its 404 passes through', async () => {
    const h = harness(noSuchRoute);
    const err = await h.fails('result', 'get', 'r1');
    const asSent = ApiError.fromEnvelope(await noSuchRoute().json(), 404);
    expect(err.exitCode).toBe(4);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe(asSent.message);
    expect((err as ApiError).nextAction).toBe(asSent.nextAction);
  });
});

describe('server text with terminal escape sequences', () => {
  const EVIL = '\u001b]0;pwned\u0007\u001b[2J\u001b[31m';
  const evilDetail = {
    ...DETAIL,
    title: `${EVIL}Checkout`,
    error: `${EVIL}Broken.`,
    trace: `${EVIL}Traceback`,
    apiOutput: `status 500${EVIL}`,
  };

  it('reaches text output without them', async () => {
    const h = harness(() => json(evilDetail));
    await h.run('result', 'get', 'r1');
    const printed = h.stdout.join('\n');
    expect(printed).not.toContain('\u001b');
    expect(printed).not.toContain('\u0007');
    expect(printed).not.toContain('pwned');
    expect(printed).toContain('FAILED  Checkout');
    expect(printed).toContain('error:          Broken.');
    expect(printed).toContain('trace:\n  Traceback');
    expect(printed).toContain('apiOutput:\n  status 500');
  });

  it('reaches JSON output as the server sent it', async () => {
    const h = harness(() => json(evilDetail));
    await h.run('--output', 'json', 'result', 'get', 'r1');
    expect(JSON.parse(h.stdout.join('\n'))).toMatchObject({
      title: evilDetail.title,
      error: evilDetail.error,
      trace: evilDetail.trace,
      apiOutput: evilDetail.apiOutput,
    });
  });

  it('preserves controls in raw error details for the rendering boundary', async () => {
    const h = harness(() => notFound('result', `r1${EVIL}`));
    const err = await h.fails('result', 'get', 'r1');
    expect(err.message).toBe('Resource not found.');
    expect((err as ApiError).details).toEqual({ resource: 'result', id: `r1${EVIL}` });
  });
});

// JSON is the wire object, passed through as the server sent it (the schemas
// are loose). These rows catch a key the CLI itself adds; that the wire never
// carries `executionId` or `code` is the backend's to guarantee: its result
// mapper builds each object from an explicit list of keys, and its specs pin
// that list.
describe('the launch is a run, and no code is printed', () => {
  it.each([
    [['result', 'list', '--run', 'e1']],
    [['result', 'list', '--test', 'test_1']],
    [['result', 'get', 'r1']],
    [['--dry-run', 'result', 'list', '--run', 'e1']],
    [['--dry-run', 'result', 'get', 'r1']],
    [['--dry-run', 'result', 'get', 'r1', '--out', 'evidence']],
  ])('output never contains "executionId" or a "code" key: %j', async args => {
    for (const mode of ['json', 'text']) {
      resetDryRunBannerForTesting();
      const h = harness();
      await h.run('--output', mode, ...args);
      expect(h.stdout.join('\n').length).toBeGreaterThan(0);
      expect(h.stdout.join('\n')).not.toMatch(/executionId|"code"\s*:/);
      expect(h.stderr.join('\n')).not.toMatch(/executionId/);
    }
  });
});
