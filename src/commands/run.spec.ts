import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { projectHarness, projectRun, runListing } from '../../test/helpers/project-run.js';
import { resultLine } from '../../test/helpers/result-list.js';
import { DRY_RUN_BANNER, resetDryRunBannerForTesting } from '../lib/client-factory.js';
import { createRunCommand, type TestDeps } from './test.js';

function root(deps: TestDeps) {
  const program = new Command('testsprite')
    .enablePositionalOptions()
    .option('--output <mode>', '', 'json')
    .option('--dry-run');
  program.addCommand(createRunCommand(deps));
  function exits(command: Command) {
    command.exitOverride();
    command.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    command.commands.forEach(exits);
  }
  exits(program);
  return { command: program, run: (args: string[]) => program.parseAsync(args, { from: 'user' }) };
}

describe('single root run selection', () => {
  it.each([['--project', 'project_1'], []])(
    'launches an unfiltered project with %j',
    async (...args) => {
      const h = projectHarness();
      await root({ ...h.deps, env: { ...h.deps.env, TESTSPRITE_PROJECT_ID: 'project_1' } }).run([
        'run',
        ...args,
        '--no-wait',
      ]);
      const posts = h.calls.filter(call => call.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0]!.url.pathname).toBe('/api/cli/v1/projects/project_1/runs');
      expect(posts[0]!.body).toEqual({ maxConcurrency: 50 });
      expect(h.calls.some(call => call.url.pathname === '/api/cli/v1/tests')).toBe(false);
    },
  );

  it('groups deduplicated named IDs by their actual project, ignoring project context', async () => {
    const h = projectHarness({
      answer: (url, init) => {
        const match = url.pathname.match(/\/tests\/(a|b|c)$/);
        if (match)
          return json({
            id: match[1],
            type: 'frontend',
            projectId: match[1] === 'b' ? 'p2' : 'p1',
          });
        if (url.pathname.endsWith('/env')) return json({ environments: [] });
        const post = url.pathname.match(/\/projects\/(p1|p2)\/runs$/);
        if (post && init.method === 'POST')
          return json(projectRun({ projectId: post[1], runId: `run-${post[1]}` }));
      },
    });
    await root({ ...h.deps, env: { ...h.deps.env, TESTSPRITE_PROJECT_ID: 'ignored' } }).run([
      'run',
      'a',
      'b',
      'a',
      'c',
      '--no-wait',
    ]);
    expect(
      h.calls.filter(call => call.method === 'POST').map(call => [call.url.pathname, call.body]),
    ).toEqual([
      ['/api/cli/v1/projects/p1/runs', { testIds: ['a', 'c'], maxConcurrency: 50 }],
      ['/api/cli/v1/projects/p2/runs', { testIds: ['b'], maxConcurrency: 50 }],
    ]);
    expect(h.calls.some(call => call.url.pathname.includes('ignored'))).toBe(false);
  });

  it('sends nothing about healing: the server decides per run', async () => {
    const h = projectHarness();
    await root(h.deps).run(['run', 'test_xyz', '--no-wait']);
    expect(h.calls.find(call => call.method === 'POST')!.body).toEqual({
      testIds: ['test_xyz'],
      maxConcurrency: 5,
    });
    await expect(
      root(h.deps).run(['run', 'test_xyz', '--no-wait', '--no-auto-heal']),
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });
  });

  it.each([
    ['a', '--project', 'project_1'],
    ['--project', ''],
    ['--project', '   '],
    ['--testlist', ''],
    ['--testlist', '   '],
    ['--project', 'project_1', '--testlist', 'list-1'],
    ['a', '--filter', 'name'],
    ...['--env', '--tunnel-client', '--filter'].map(flag => [
      '--testlist',
      'list-1',
      flag,
      'value',
    ]),
    ...['--no-cancel-on-interrupt', '--skip-dependencies'].map(flag => [
      '--testlist',
      'list-1',
      flag,
    ]),
  ])('rejects selectors or list flags before business work: %j', async (...args) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              message: 'Selector validation must prevent this request.',
              nextAction: 'Reject conflicting selectors locally.',
              requestId: 'req-selector-validation',
              details: {},
            },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    );
    const createTunnelClient = vi.fn();
    const error = await root({
      fetchImpl,
      createTunnelClient,
      env: {
        TESTSPRITE_API_KEY: 'sk-user-test',
        TESTSPRITE_API_URL: 'https://api.example.com',
        TESTSPRITE_PROJECT_ID: 'fallback',
      },
    })
      .run(['run', ...args])
      .catch((caught: unknown) => caught);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createTunnelClient).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('requires a project context without named tests or a list', async () => {
    await expect(root({ env: {} }).run(['run'])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
    });
  });
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('run --dry-run banner', () => {
  // With credentials, the environment preflight goes through a live client, so
  // no dry-run response fires the lazy banner; the preview must emit it itself.
  it.each([[['--project', 'project_1']], [['test_xyz']], [['a', 'b']]])(
    'prints the banner exactly once for run %j',
    async args => {
      resetDryRunBannerForTesting();
      const h = projectHarness({
        answer: url => (url.pathname.endsWith('/env') ? json({ environments: [] }) : undefined),
      });
      await root(h.deps).run(['--dry-run', 'run', ...args]);
      expect(h.stderr.filter(line => line === DRY_RUN_BANNER)).toHaveLength(1);
      expect(h.calls.every(call => call.method === 'GET')).toBe(true);
      expect(JSON.parse(h.stdout.join(''))).toMatchObject({ dryRun: true });
    },
  );

  it('prints no banner when local validation refuses the dry run', async () => {
    resetDryRunBannerForTesting();
    const h = projectHarness();
    const ids = Array.from({ length: 5001 }, (_, i) => `t${i}`);
    await expect(root(h.deps).run(['--dry-run', 'run', ...ids])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
    });
    expect(h.calls).toEqual([]);
    expect(h.stderr).not.toContain(DRY_RUN_BANNER);
  });
});

describe('root list and lifecycle adapters', () => {
  function listHarness(receipt: unknown = { accepted: [], conflicts: [], deferred: [] }) {
    return projectHarness({
      answer: (url, init) => {
        if (url.pathname.endsWith('/testlist/list-1')) return json({ id: 'list-1', cases: [] });
        if (url.pathname.endsWith('/testlist/list-1/run') && init.method === 'POST')
          return json(receipt);
      },
    });
  }

  it.each([[], ['a', 'b', 'a']])(
    'launches whole list or ordered deduplicated subset %j',
    async (...ids) => {
      const h = listHarness();
      await root({ ...h.deps, env: { ...h.deps.env, TESTSPRITE_PROJECT_ID: 'ignored' } }).run([
        'run',
        ...ids,
        '--testlist',
        'list-1',
        '--no-wait',
        // The harness's list starts nothing; without this the launch is exit 5.
        '--allow-empty',
      ]);
      const posts = h.calls.filter(call => call.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0]!.url.pathname).toBe('/api/cli/v1/testlist/list-1/run');
      expect(posts[0]!.body).toEqual({
        ...(ids.length ? { testIds: ['a', 'b'] } : {}),
        maxConcurrency: 10,
      });
      expect(JSON.parse(h.stdout.join(''))).toMatchObject({
        runs: [],
        results: [],
        conflicts: [],
        deferred: [],
      });
    },
  );

  it('retains list concurrency range instead of the project range', async () => {
    const h = listHarness();
    await expect(
      root(h.deps).run(['run', '--testlist', 'list-1', '--max-concurrency', '51']),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.calls).toEqual([]);
  });

  it('waits independently for deduplicated run IDs without dispatching', async () => {
    const h = projectHarness({
      answer: url => {
        if (url.pathname.endsWith('/results')) {
          const id = url.searchParams.get('run')!;
          return json(
            runListing({ runId: id, status: 'finished', cancelled: false }, [
              resultLine({ resultId: `r-${id}`, runId: id, testStatus: 'PASSED' }),
            ]),
          );
        }
      },
    });
    await root(h.deps).run(['run', 'wait', 'r1', 'r2', 'r1', '--timeout', '17']);
    expect(h.calls.map(call => call.url.searchParams.get('run'))).toEqual(['r1', 'r2']);
    expect(h.calls.every(call => call.method === 'GET')).toBe(true);
    expect(JSON.parse(h.stdout.join('')).summary).toMatchObject({ total: 2, passed: 2 });
  });

  it('cancels once per unique run without enumerating members', async () => {
    const h = projectHarness({
      answer: url => {
        if (url.pathname.includes('/cancel'))
          return json({
            runId: url.pathname.split('/').at(-2),
            alreadyFinished: false,
            alreadyCancelled: false,
            results: [],
          });
      },
    });
    await root(h.deps).run(['run', 'cancel', 'r1', 'r2', 'r1']);
    expect(h.calls.map(call => [call.method, call.url.pathname])).toEqual([
      ['POST', '/api/cli/v1/runs/r1/cancel'],
      ['POST', '/api/cli/v1/runs/r2/cancel'],
    ]);
  });

  it.each([
    ['--project', 'p', 'wait', 'r'],
    ['--timeout', '17', 'wait', 'r'],
    ['--no-wait', 'cancel', 'r'],
    ['--testlist', 'l', 'cancel', 'r'],
  ])('rejects parent launch options before lifecycle child: %j', async (...args) => {
    const fetchImpl = vi.fn();
    await expect(root({ fetchImpl }).run(['run', ...args])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['wait', 'cancel'])('rejects dispatch concurrency on %s', async child => {
    await expect(root({}).run(['run', child, 'r', '--max-concurrency', '4'])).rejects.toMatchObject(
      { code: 'commander.unknownOption' },
    );
  });
});
