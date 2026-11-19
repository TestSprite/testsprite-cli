import { describe, expect, it } from 'vitest';
import { ApiError } from '../errors.js';
import { HttpClient, type FetchImpl } from '../http.js';
import { resultApi, type ResultApi } from './api.js';
import {
  ALL_RESULT_STATUSES,
  type ResultDetail,
  type ResultLine,
  type ResultStep,
} from './types.js';

const BASE = 'https://api.example.com/api/cli/v1';

const STEP: ResultStep = {
  stepIndex: '2',
  type: 'assertion',
  action: 'expect',
  description: 'Expect the order confirmation heading',
  status: 'failed',
  selector: 'h1.confirmation',
  url: 'https://staging.example.com/checkout',
  healed: false,
  screenshotSignedUrl: 'https://storage.example.com/steps/2.png',
  htmlSignedUrl: 'https://storage.example.com/steps/2.html',
};

const LINE: ResultLine = {
  resultId: 'r1',
  runId: 'e1',
  caseKey: 'AUD-004',
  title: 'Checkout shows the order confirmation',
  testStatus: 'FAILED',
  processStatus: 'Idle',
  error: 'The confirmation heading never appeared.',
  blockedReason: null,
  environmentName: 'staging',
  created: '2026-11-10T08:00:00.000Z',
};

const DETAIL: ResultDetail = {
  resultId: 'r1',
  runId: 'e1',
  caseKey: 'AUD-004',
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
  failedStep: STEP,
  steps: [STEP],
  signIn: null,
};

/** The API over the real HttpClient, answering every request with one body. */
function apiAnswering(body: unknown) {
  const routes: string[] = [];
  const fetchImpl: FetchImpl = async (input, init = {}) => {
    const url = String(input);
    routes.push(`${init.method ?? 'GET'} ${url.slice(BASE.length)}`);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new HttpClient({
    baseUrl: BASE,
    apiKey: 'sk-user-abc',
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  return { api: resultApi(client), routes };
}

describe('resultApi', () => {
  describe('listByRun', () => {
    it('asks for the results of a run in the statuses named', async () => {
      const { api, routes } = apiAnswering({ results: [LINE] });
      await expect(api.listByRun('e1', ['failed', 'blocked'])).resolves.toEqual({
        results: [LINE],
      });
      expect(routes).toEqual(['GET /results?run=e1&status=failed%2Cblocked']);
    });

    it('sends no status when none is named, leaving the default to the server', async () => {
      const { api, routes } = apiAnswering({ results: [] });
      await api.listByRun('e1');
      await api.listByRun('e1', []);
      expect(routes).toEqual(['GET /results?run=e1', 'GET /results?run=e1']);
    });

    it('names every status, cancelled included, when handed ALL_RESULT_STATUSES', async () => {
      const { api, routes } = apiAnswering({ results: [] });
      await api.listByRun('e1', ALL_RESULT_STATUSES);
      expect(routes).toEqual([
        'GET /results?run=e1&status=passed%2Cfailed%2Crunning%2Cblocked%2Ccancelled',
      ]);
    });

    it('encodes the run id', async () => {
      const { api, routes } = apiAnswering({ results: [] });
      await api.listByRun('e 1/&status=cancelled');
      expect(routes).toEqual(['GET /results?run=e+1%2F%26status%3Dcancelled']);
    });
  });

  describe('listByTest', () => {
    it("asks for a test's history with the environment and the limit", async () => {
      const body = { results: [LINE], hiddenRunCount: 3, retentionDays: 30 };
      const { api, routes } = apiAnswering(body);
      await expect(api.listByTest('case-a', { env: 'staging', limit: 5 })).resolves.toEqual(body);
      expect(routes).toEqual(['GET /results?test=case-a&environment=staging&limit=5']);
    });

    it('sends only the test id when nothing narrows the history', async () => {
      const { api, routes } = apiAnswering({ results: [] });
      await api.listByTest('case-a');
      await api.listByTest('case-a', { statuses: [] });
      expect(routes).toEqual(['GET /results?test=case-a', 'GET /results?test=case-a']);
    });

    it('sends the statuses named', async () => {
      const { api, routes } = apiAnswering({ results: [] });
      await api.listByTest('case-a', { statuses: ['cancelled'], limit: 1 });
      expect(routes).toEqual(['GET /results?test=case-a&status=cancelled&limit=1']);
    });

    it('encodes the test id and the environment name', async () => {
      const { api, routes } = apiAnswering({ results: [] });
      await api.listByTest('case a&run=e1', { env: 'pre prod&limit=100' });
      expect(routes).toEqual([
        'GET /results?test=case+a%26run%3De1&environment=pre+prod%26limit%3D100',
      ]);
    });
  });

  describe('get', () => {
    it('reads one result by id', async () => {
      const { api, routes } = apiAnswering(DETAIL);
      await expect(api.get('r1')).resolves.toEqual(DETAIL);
      expect(routes).toEqual(['GET /results/r1']);
    });

    it('encodes the result id into one path segment', async () => {
      const { api, routes } = apiAnswering(DETAIL);
      await api.get('r1/steps?x=1 #y');
      expect(routes).toEqual(['GET /results/r1%2Fsteps%3Fx%3D1%20%23y']);
    });
  });

  describe('a caller signal', () => {
    /** The API over a server that never answers until the request is aborted. */
    function apiHanging() {
      const fetchImpl: FetchImpl = (_input, init = {}) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        });
      const client = new HttpClient({
        baseUrl: BASE,
        apiKey: 'sk-user-abc',
        fetchImpl,
        sleep: () => Promise.resolve(),
        random: () => 0,
      });
      return resultApi(client);
    }

    it.each([
      ['listByRun', (api: ResultApi, signal: AbortSignal) => api.listByRun('e1', [], { signal })],
      ['listByTest', (api: ResultApi, signal: AbortSignal) => api.listByTest('case-a', { signal })],
      ['get', (api: ResultApi, signal: AbortSignal) => api.get('r1', { signal })],
    ])('%s stops when the caller aborts', async (_name, read) => {
      const caller = new AbortController();
      const pending = read(apiHanging(), caller.signal);
      caller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  describe('retry: false', () => {
    it('listByRun tries a throttled listing once, without waiting out its Retry-After', async () => {
      let requests = 0;
      const fetchImpl: FetchImpl = async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            error: { code: 'RATE_LIMITED', message: 'slow down', requestId: 'r', details: {} },
          }),
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } },
        );
      };
      const sleeps: number[] = [];
      const client = new HttpClient({
        baseUrl: BASE,
        apiKey: 'sk-user-abc',
        fetchImpl,
        sleep: ms => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        random: () => 0,
      });
      await expect(resultApi(client).listByRun('e1', [], { retry: false })).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
      expect(requests).toBe(1);
      expect(sleeps).toEqual([]);
    });
  });

  describe('response shape', () => {
    it('reads a nullable field the server left out as null and keeps a field it does not know', async () => {
      const { api } = apiAnswering({
        results: [
          {
            resultId: 'r1',
            title: 'Checkout shows the order confirmation',
            testStatus: 'PASSED',
            created: '2026-11-10T08:00:00.000Z',
            addedLater: true,
          },
        ],
      });
      const { results } = await api.listByRun('e1');
      expect(results[0]).toEqual({
        resultId: 'r1',
        runId: null,
        caseKey: null,
        title: 'Checkout shows the order confirmation',
        testStatus: 'PASSED',
        processStatus: null,
        error: null,
        blockedReason: null,
        environmentName: null,
        created: '2026-11-10T08:00:00.000Z',
        addedLater: true,
      });
    });

    it('leaves out the history fields a run listing does not carry', async () => {
      const { api } = apiAnswering({ results: [] });
      const list = await api.listByRun('e1');
      expect('hiddenRunCount' in list).toBe(false);
      expect('retentionDays' in list).toBe(false);
    });

    it("reads a run listing's run and each result's last change", async () => {
      const run = {
        runId: 'e1',
        projectId: 'p1',
        status: 'finished',
        cancelled: false,
        created: '2026-11-10T08:00:00.000Z',
        modified: '2026-11-10T08:02:00.000Z',
        targetUrl: 'https://staging.example.com',
        dashboardUrl: 'https://www.testsprite.com/dashboard-v3/runs/e1',
      };
      const { api } = apiAnswering({
        run,
        results: [{ ...LINE, modified: '2026-11-10T08:01:00.000Z' }],
      });
      const list = await api.listByRun('e1');
      expect(list.run).toEqual(run);
      expect(list.results[0]?.modified).toBe('2026-11-10T08:01:00.000Z');
    });

    it('reads a run without its id or status as null, and still lists the results', async () => {
      // A read that does not use the run keeps working; a wait refuses it.
      const { api } = apiAnswering({ run: { runId: 'e1', status: 7 }, results: [LINE] });
      const list = await api.listByRun('e1');
      expect(list.run).toBeNull();
      expect(list.results).toEqual([LINE]);
    });

    it('reads a run that names only its id and status, the rest as null', async () => {
      const { api } = apiAnswering({ run: { runId: 'e1', status: 'running' }, results: [] });
      const list = await api.listByRun('e1');
      expect(list.run).toEqual({
        runId: 'e1',
        projectId: null,
        status: 'running',
        cancelled: null,
        created: null,
        modified: null,
        targetUrl: null,
        dashboardUrl: null,
      });
    });

    it('reads a field of the run it cannot make sense of as null, and keeps the run', async () => {
      const { api } = apiAnswering({
        run: { runId: 'e1', status: 'finished', projectId: 5, cancelled: 'yes', created: {} },
        results: [],
      });
      const list = await api.listByRun('e1');
      expect(list.run).toMatchObject({
        runId: 'e1',
        status: 'finished',
        projectId: null,
        cancelled: null,
        created: null,
      });
    });

    it('keeps the sign-in run of a blocked result', async () => {
      const signIn = {
        id: 'auth_1',
        status: null,
        videoUrl: null,
        finalUrl: 'https://staging.example.com/login',
        stepCount: 1,
        error: 'The password was rejected.',
        steps: [{ ...STEP, screenshotSignedUrl: null }],
      };
      const blocked = { ...DETAIL, testStatus: 'BLOCKED', failedStep: null, steps: [], signIn };
      const { api } = apiAnswering(blocked);
      await expect(api.get('r1')).resolves.toEqual(blocked);
    });

    it.each([
      ['a list without results', { items: [] }, (api: ResultApi) => api.listByRun('x')],
      [
        'a result without an id',
        { ...DETAIL, resultId: undefined },
        (api: ResultApi) => api.get('x'),
      ],
    ])('refuses %s', async (_what, body, read) => {
      const { api } = apiAnswering(body);
      const error = await read(api).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('INTERNAL');
    });
  });
});
