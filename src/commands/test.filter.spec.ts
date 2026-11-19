import { projectRun, runListing } from '../../test/helpers/project-run.js';
import { resultLine } from '../../test/helpers/result-list.js';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { createCiCommand } from './ci.js';
import { createRunCommand } from './test.js';

const projectTests = [
  { id: 'test-alpha', title: 'Alpha checkout', type: 'backend' },
  { id: 'test-beta', title: 'Beta', type: 'backend' },
];

const batchCommands = [
  {
    name: 'run',
    args: ['run', '--no-wait'],
    path: '/projects/project-1/runs',
  },
  {
    name: 'ci run',
    args: ['ci', 'run', '--no-execution-report'],
    path: '/projects/project-1/runs',
  },
];

/** All reads and dispatches are fixtures; no request reaches a real server. */
function harness() {
  const stdout: string[] = [];
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace('/api/cli/v1', '');
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    requests.push({ path, method, body });
    let response: unknown;
    if (path === '/tests' && method === 'GET') {
      response = { items: projectTests, nextToken: null };
    } else if (path === '/projects/project-1/env' && method === 'GET') {
      response = {
        environments: [
          {
            id: 'env-default',
            name: 'default',
            url: 'https://app.example.com',
            isDefault: true,
            authMode: 'account',
          },
        ],
      };
    } else if (method === 'POST' && path === '/projects/project-1/runs') {
      const ids = (body.testIds as string[] | undefined) ?? projectTests.map(test => test.id);
      response = projectRun({ runId: 'exec-filter', projectId: 'project-1', total: ids.length });
    } else if (path === '/results' && method === 'GET') {
      const dispatched = requests.find(request => request.method === 'POST')?.body.testIds as
        string[] | undefined;
      response = runListing(
        { runId: 'exec-filter', status: 'finished', cancelled: false },
        (dispatched ?? projectTests.map(test => test.id)).map(id =>
          resultLine({
            resultId: `result-${id}`,
            runId: 'exec-filter',
            caseKey: id,
            testStatus: 'PASSED',
          }),
        ),
      );
    } else {
      // A non-retryable fixture error also bounds pre-fix single-test failures.
      return new Response(
        JSON.stringify({
          code: 'AUTH_INVALID',
          message: `Unexpected request: ${method} ${path}`,
          nextAction: 'Check the test fixture.',
          requestId: 'fixture',
          details: {},
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(response), {
      status: method === 'POST' ? 202 : 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const deps = {
    env: {
      TESTSPRITE_API_KEY: 'sk-user-test',
      TESTSPRITE_API_URL: 'http://localhost:13599',
    },
    fetchImpl,
    stdout: (line: string) => stdout.push(line),
    stderr: () => {},
    sleep: async () => {},
  };
  const root = new Command('testsprite').option('--output <mode>', '', 'json').option('--dry-run');
  root.addCommand(createRunCommand(deps));
  root.addCommand(createCiCommand(deps));
  return {
    fetchImpl,
    stdout,
    requests,
    run: (args: string[]) => root.parseAsync(args, { from: 'user' }),
  };
}

describe('CLI name-filter validation', () => {
  const commands = [
    ...batchCommands.map(command => ({
      name: `${command.name} project`,
      args: [...command.args, '--project', 'project-1'],
    })),
    { name: 'run single', args: ['run', 'test-alpha', '--no-wait'] },
    {
      name: 'run multiple',
      args: ['run', 'test-alpha', 'test-beta', '--no-wait'],
    },
  ];

  describe.each(commands)('$name', ({ args }) => {
    it.each([false, true])(
      'rejects an empty filter before any request (dryRun=%s)',
      async dryRun => {
        const h = harness();
        await expect(
          h.run([...(dryRun ? ['--dry-run'] : []), ...args, '--filter', '']),
        ).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
          exitCode: 5,
          details: { field: 'filter' },
          nextAction: expect.stringMatching(/omit --filter.*non-empty substring/),
        });
        expect(h.fetchImpl).not.toHaveBeenCalled();
        expect(h.stdout).toEqual([]);
      },
    );

    it('also rejects the --filter= spelling before any request', async () => {
      const h = harness();
      await expect(h.run([...args, '--filter='])).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        exitCode: 5,
        details: { field: 'filter' },
      });
      expect(h.fetchImpl).not.toHaveBeenCalled();
    });
  });

  it('previews a project title filter without substituting dry-run sample tests', async () => {
    const h = harness();
    await h.run([
      '--dry-run',
      'run',
      '--project',
      'project-1',
      '--filter',
      'new checkout',
      '--wait',
    ]);
    const output = JSON.parse(h.stdout.join(''));
    expect(output).toMatchObject({
      dryRun: true,
      runs: [],
      results: [],
      summary: { total: 0 },
      filter: 'new checkout',
      requests: [
        { method: 'GET', path: '/api/cli/v1/tests?projectId=project-1' },
        {
          method: 'POST',
          path: '/api/cli/v1/projects/project-1/runs',
          body: { testIds: ['<matching-test-id>'] },
        },
      ],
    });
    expect(h.requests.some(row => row.method === 'POST' || row.path === '/tests')).toBe(false);
  });

  describe.each(batchCommands)('$name selection controls', ({ args, path }) => {
    it.each([
      { name: 'omitted', filter: undefined, expectedIds: ['test-alpha', 'test-beta'] },
      { name: 'non-empty, case-insensitive', filter: 'aLPHa', expectedIds: ['test-alpha'] },
      { name: 'whitespace-only, not trimmed', filter: ' ', expectedIds: ['test-alpha'] },
    ])('preserves $name filtering', async ({ filter, expectedIds }) => {
      const h = harness();
      await h.run([
        ...args,
        '--project',
        'project-1',
        ...(filter === undefined ? [] : ['--filter', filter]),
      ]);
      const dispatches = h.requests.filter(request => request.method === 'POST');
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]!.path).toBe(path);
      const selected = dispatches[0]!.body.testIds ?? projectTests.map(test => test.id);
      expect(selected).toEqual(expectedIds);
    });
  });
});
