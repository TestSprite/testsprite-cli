/** Native execution fixtures. A listing's execution state is always explicit. */
import type { ProjectRunResponse, RunResponse } from '../../src/lib/runs.types.js';
import type { ResultLine, ResultList, ResultRun } from '../../src/lib/result/types.js';

export function projectRun(overrides: Partial<ProjectRunResponse> = {}): ProjectRunResponse {
  return {
    runId: 'exec_abc',
    projectId: 'project_1',
    total: 1,
    enqueuedAt: '2026-05-15T10:00:00.000Z',
    autoHeal: true,
    environment: { id: 'env_default', name: 'default' },
    targetUrl: 'https://example.com',
    blocked: [],
    held: [],
    ...overrides,
  };
}

export function runListing(
  state: Pick<ResultRun, 'status' | 'cancelled'> & Partial<ResultRun>,
  results: ResultLine[],
): ResultList {
  return {
    run: {
      runId: 'exec_abc',
      projectId: 'project_1',
      created: '2026-05-15T10:00:00.000Z',
      modified: '2026-05-15T10:01:00.000Z',
      targetUrl: 'https://example.com',
      dashboardUrl: null,
      ...state,
    },
    results,
  };
}

export function resultCard(overrides: Partial<RunResponse> = {}): RunResponse {
  return {
    resultId: 'run_abc',
    runId: 'exec_abc',
    testId: 'test_xyz',
    projectId: 'project_1',
    userId: 'user_1',
    status: 'running',
    source: 'cli',
    createdAt: '2026-05-15T10:00:00.000Z',
    startedAt: '2026-05-15T10:00:01.000Z',
    finishedAt: null,
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
    environment: { id: 'env_default', name: 'default' },
    createdFrom: 'cli',
    failedStepIndex: null,
    failureKind: null,
    error: null,
    videoUrl: null,
    stepSummary: { total: 5, completed: 0, passedCount: 0, failedCount: 0 },
    ...overrides,
  };
}

export function projectHarness(
  options: {
    launch?: ProjectRunResponse;
    listing?: () => ResultList | Promise<ResultList>;
    answer?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
  } = {},
) {
  const calls: Array<{ url: URL; method: string; body: unknown; headers: Headers }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  return {
    calls,
    stdout,
    stderr,
    json,
    deps: {
      env: { TESTSPRITE_API_KEY: 'sk-user-test', TESTSPRITE_API_URL: 'https://api.example.com' },
      stdout: (line: string) => {
        stdout.push(line);
      },
      stderr: (line: string) => {
        stderr.push(line);
      },
      sleep: async () => {},
      fetchImpl: async (
        input: string | URL | Request,
        init: RequestInit = {},
      ): Promise<Response> => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        calls.push({
          url,
          method: init.method ?? 'GET',
          body: init.body ? JSON.parse(String(init.body)) : undefined,
          headers: new Headers(init.headers),
        });
        const answer = await options.answer?.(url, init);
        if (answer) return answer;
        if ((init.method ?? 'GET') === 'GET' && url.pathname === '/api/cli/v1/tests/test_xyz')
          return json({ id: 'test_xyz', type: 'frontend', projectId: 'project_1' });
        if ((init.method ?? 'GET') === 'GET' && url.pathname === '/api/cli/v1/projects/project_1')
          return json({ id: 'project_1', type: 'frontend' });
        if (
          (init.method ?? 'GET') === 'GET' &&
          url.pathname === '/api/cli/v1/projects/project_1/env'
        )
          return json({
            environments: [
              { id: 'env_default', name: 'default', url: 'https://example.com', isDefault: true },
            ],
          });
        if (init.method === 'POST' && url.pathname === '/api/cli/v1/projects/project_1/runs')
          return json(options.launch ?? projectRun());
        if (
          (init.method ?? 'GET') === 'GET' &&
          url.pathname === '/api/cli/v1/results' &&
          options.listing
        )
          return json(await options.listing());
        throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${url}`);
      },
    },
  };
}
