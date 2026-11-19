import { describe, expect, it } from 'vitest';
import { ApiError, InterruptError, RequestTimeoutError } from '../lib/errors.js';
import { ShutdownController } from '../lib/interrupt.js';
import type { CancelRunResponse, CancelRunRefund } from '../lib/runs.types.js';
import { runTestCancel } from './test.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (code: string, status: number) =>
  json(
    {
      error: {
        code,
        message: `${code} from server`,
        nextAction: 'Keep server instruction.',
        requestId: 'server-request',
        details: { resource: 'run' },
      },
    },
    status,
  );
const response = (runId: string, extra: Partial<CancelRunResponse> = {}): CancelRunResponse => ({
  runId,
  alreadyCancelled: false,
  alreadyFinished: false,
  results: ['a', 'b'].map(id => ({
    resultId: `${runId}-${id}`,
    runId,
    testId: id,
    title: `Test ${id}`,
    status: 'cancelled',
    alreadyCancelled: false,
    alreadyFinished: false,
  })),
  ...extra,
});
function harness(
  answer: (runId: string, init: RequestInit) => Response | Promise<Response> = id =>
    json(response(id)),
) {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const shutdown = new ShutdownController();
  const deps = {
    env: { TESTSPRITE_API_KEY: 'sk-user-test', TESTSPRITE_API_URL: 'https://api.example.com' },
    shutdown,
    stdout: (s: string) => stdout.push(s),
    stderr: (s: string) => stderr.push(s),
    sleep: async () => undefined,
    fetchImpl: async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      calls.push(`${init.method} ${url.pathname}`);
      const match = /^\/api\/cli\/v1\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (init.method !== 'POST' || !match) throw new Error(`unexpected request ${url}`);
      return answer(decodeURIComponent(match[1]!), init);
    },
  };
  return {
    calls,
    stdout,
    stderr,
    shutdown,
    deps,
    cancel: (runIds = ['e1'], output: 'json' | 'text' = 'json') =>
      runTestCancel({ profile: 'default', debug: false, output, runIds }, deps),
    doc: () => JSON.parse(stdout.join('\n')),
  };
}

describe('run cancel: one request per execution', () => {
  it('does not list members and sends each unique run once in input order', async () => {
    const h = harness();
    const summary = await h.cancel(['e2', 'e1', 'e2']);
    expect(h.calls).toEqual(['POST /api/cli/v1/runs/e2/cancel', 'POST /api/cli/v1/runs/e1/cancel']);
    expect(summary.cancelled).toEqual(['e2', 'e1']);
    expect(h.doc().runs).toEqual([response('e2'), response('e1')]);
  });
  it('preserves every native result identity and status in JSON', async () => {
    const h = harness();
    await h.cancel();
    expect(h.doc()).toEqual({
      runs: [response('e1')],
      cancelled: ['e1'],
      alreadyCancelled: [],
      alreadyFinished: [],
      notFound: [],
      errors: [],
    });
  });
  it('renders run and result identities separately in text', async () => {
    const h = harness();
    await h.cancel(['e1'], 'text');
    expect(h.stdout.join('\n')).toBe('Run e1 — cancelled\n  e1-a  cancelled\n  e1-b  cancelled');
  });
  it.each(['alreadyCancelled', 'alreadyFinished'] as const)(
    'accepts %s on HTTP 200',
    async field => {
      const body = response('e1', { [field]: true });
      const h = harness(() => json(body));
      const result = await h.cancel();
      expect(result[field]).toEqual(['e1']);
      expect(result.cancelled).toEqual([]);
      expect(h.doc().runs).toEqual([body]);
    },
  );
  it('still cancels a run whose current result list is empty', async () => {
    const h = harness(() => json(response('e1', { results: [] })));
    expect((await h.cancel()).cancelled).toEqual(['e1']);
    expect(h.calls).toHaveLength(1);
  });
  it('keeps mixed finished and cancelled result statuses from the server', async () => {
    const body = response('e1');
    body.results[0] = { ...body.results[0]!, status: 'passed', alreadyFinished: true };
    const h = harness(() => json(body));
    await h.cancel();
    expect(h.doc().runs[0].results).toEqual(body.results);
  });
  it('uses the server terminal-race response without a second request', async () => {
    const body = response('e1', { alreadyFinished: true });
    const h = harness(() => json(body));
    await h.cancel();
    expect(h.calls).toHaveLength(1);
    expect(h.doc().alreadyFinished).toEqual(['e1']);
  });
});

describe('run cancel: refunds', () => {
  const cases: Array<CancelRunRefund | undefined> = [
    { status: 'refunded', amount: 2.5 },
    { status: 'refunded' },
    { status: 'not_charged' },
    { status: 'failed' },
    undefined,
  ];
  it.each(cases)('preserves refund %j on its result', async refund => {
    const body = response('e1');
    if (refund) body.results[0]!.refund = refund;
    const h = harness(() => json(body));
    await h.cancel();
    expect(h.doc().runs[0].results[0]).toEqual(body.results[0]);
  });
  it.each(cases)('renders refund %j honestly', async refund => {
    const body = response('e1');
    if (refund) body.results[0]!.refund = refund;
    const h = harness(() => json(body));
    await h.cancel(['e1'], 'text');
    if (refund?.status === 'failed')
      expect(h.stdout.join('')).toContain('retry testsprite run cancel');
    else if (refund?.status === 'not_charged') expect(h.stdout.join('')).toContain('never charged');
    else if (refund) expect(h.stdout.join('')).toContain('credits returned');
    else expect(h.stdout.join('')).not.toContain('refund:');
  });
  it('reissues cancellation for a failed refund even when the run was already cancelled', async () => {
    let attempts = 0;
    const h = harness(() => {
      const body = response('e1', { alreadyCancelled: true });
      body.results[0]!.refund =
        ++attempts === 1 ? { status: 'failed' } : { status: 'refunded', amount: 1 };
      return json(body);
    });
    await h.cancel();
    h.stdout.length = 0;
    await h.cancel();
    expect(h.calls).toHaveLength(2);
    expect(h.doc().runs[0].results[0].refund).toEqual({ status: 'refunded', amount: 1 });
  });
  it('refuses malformed nested refund metadata at the schema boundary', async () => {
    const body = response('e1');
    const h = harness(() =>
      json({ ...body, results: [{ ...body.results[0], refund: { amount: 3 } }] }),
    );
    await expect(h.cancel()).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(h.doc().errors[0].runId).toBe('e1');
  });
});

describe('run cancel: partial failures and precedence', () => {
  it.each([
    ['AUTH_INVALID', 401, 3],
    ['CLIENT_TOO_OLD', 426, 14],
    ['NOT_FOUND', 404, 4],
    ['CONFLICT', 409, 6],
    ['RATE_LIMITED', 429, 11],
    ['INTERNAL', 500, 1],
  ] as const)('preserves %s with its server message and hint', async (code, status, exitCode) => {
    const h = harness(() => failure(code, status));
    await expect(h.cancel()).rejects.toMatchObject({
      code,
      exitCode,
      message: `${code} from server`,
      nextAction: 'Keep server instruction.',
      requestId: 'server-request',
      details: { resource: 'run' },
    });
    expect(h.stdout).toHaveLength(1);
  });
  it('continues to the next run after a request failed', async () => {
    const h = harness(id => (id === 'missing' ? failure('NOT_FOUND', 404) : json(response(id))));
    await expect(h.cancel(['missing', 'e1'])).rejects.toMatchObject({ exitCode: 4 });
    expect(h.doc().cancelled).toEqual(['e1']);
    expect(h.doc().notFound).toEqual(['missing']);
  });
  it.each([
    ['NOT_FOUND', 404, 'INTERNAL', 500, 4],
    ['AUTH_INVALID', 401, 'NOT_FOUND', 404, 3],
    ['CLIENT_TOO_OLD', 426, 'AUTH_INVALID', 401, 3],
    ['CLIENT_TOO_OLD', 426, 'NOT_FOUND', 404, 14],
  ] as const)(
    'chooses precedence across %s and %s',
    async (first, firstStatus, second, secondStatus, exitCode) => {
      const h = harness(id =>
        id === 'e1' ? failure(first, firstStatus) : failure(second, secondStatus),
      );
      await expect(h.cancel(['e1', 'e2'])).rejects.toMatchObject({ exitCode });
    },
  );
  it('reports a request timeout as an attempted run, retaining earlier successes', async () => {
    const h = harness(id => {
      if (id === 'e2') throw new RequestTimeoutError(1000, 'request');
      return json(response(id));
    });
    await expect(h.cancel(['e1', 'e2'])).rejects.toMatchObject({ exitCode: 1 });
    expect(h.doc().cancelled).toEqual(['e1']);
    expect(h.doc().errors[0].runId).toBe('e2');
  });
  it('renders missing runs and request errors in text', async () => {
    const h = harness(id => (id === 'e1' ? failure('NOT_FOUND', 404) : failure('CONFLICT', 409)));
    await expect(h.cancel(['e1', 'e2'], 'text')).rejects.toBeInstanceOf(ApiError);
    expect(h.stdout.join('')).toContain('Run e1 — not found');
    expect(h.stdout.join('')).toContain('Run e2 — CONFLICT from server');
  });
});

describe('run cancel: interrupts', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'preserves %s and reports completed/current/unattempted requests',
    async signal => {
      const h = harness(id => {
        if (id === 'e2') throw new InterruptError(signal);
        return json(response(id));
      });
      await expect(h.cancel(['e1', 'e2', 'e3'])).rejects.toMatchObject({
        exitCode: signal === 'SIGINT' ? 130 : 143,
      });
      expect(h.calls).toHaveLength(2);
      expect(h.doc().cancelled).toEqual(['e1']);
      expect(h.doc().interrupted).toBe('e2');
      expect(h.doc().notAttempted).toEqual(['e3']);
    },
  );
  it('interrupt outranks an earlier missing run', async () => {
    const h = harness(id => {
      if (id === 'e2') throw new InterruptError('SIGINT');
      return failure('NOT_FOUND', 404);
    });
    await expect(h.cancel(['e1', 'e2'])).rejects.toMatchObject({ exitCode: 130 });
    expect(h.doc().notFound).toEqual(['e1']);
  });
  it('dry-run uses the native canned cancel envelope offline', async () => {
    const h = harness(() => {
      throw new Error('network called');
    });
    await runTestCancel(
      { profile: 'default', debug: false, output: 'json', runIds: ['sample'], dryRun: true },
      {
        ...h.deps,
        fetchImpl: undefined,
        env: {},
        credentialsPath: '/tmp/no-credentials-for-cancel-contract',
      },
    );
    expect(h.calls).toHaveLength(0);
    expect(h.doc().runs[0].results[0]).toHaveProperty('resultId');
  });
});
