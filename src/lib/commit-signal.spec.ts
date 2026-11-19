import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMIT_SIGNAL_BACKOFF_MS,
  COMMIT_SIGNAL_MAX_PAGES,
  decideCommitSignal,
  nextLink,
  normalizeCheckRun,
  normalizeStatus,
  waitForCommitSignal,
  type CommitSignal,
} from './commit-signal.js';
import { CLIError, InterruptError } from './errors.js';
import { ShutdownController } from './interrupt.js';

afterEach(() => vi.restoreAllMocks());

const T0 = '2026-10-23T21:00:00Z';

function status(over: Record<string, unknown> = {}) {
  return {
    context: 'Vercel',
    state: 'success',
    description: 'Deployment has completed',
    updated_at: T0,
    ...over,
  };
}
function check(over: Record<string, unknown> = {}) {
  return {
    name: 'Cloudflare Pages',
    status: 'completed',
    conclusion: 'success',
    completed_at: T0,
    output: { title: 'Deployed' },
    ...over,
  };
}

describe('normalizeStatus / normalizeCheckRun', () => {
  it('maps the status states', () => {
    expect(normalizeStatus(status())!.state).toBe('success');
    expect(normalizeStatus(status({ state: 'pending' }))!.state).toBe('pending');
    expect(normalizeStatus(status({ state: 'failure' }))!.state).toBe('failure');
    expect(normalizeStatus(status({ state: 'error' }))!.state).toBe('failure');
    expect(normalizeStatus({ state: 'success' })).toBeNull();
  });

  it('maps check-run status + conclusion', () => {
    expect(normalizeCheckRun(check({ status: 'in_progress', conclusion: null }))!.state).toBe(
      'pending',
    );
    expect(normalizeCheckRun(check({ status: 'queued' }))!.state).toBe('pending');
    expect(normalizeCheckRun(check())!.state).toBe('success');
    expect(normalizeCheckRun(check({ conclusion: 'neutral' }))!.state).toBe('success');
    expect(normalizeCheckRun(check({ conclusion: 'skipped' }))!.state).toBe('skip');
    expect(normalizeCheckRun(check({ conclusion: 'cancelled' }))!.state).toBe('skip');
    for (const c of ['failure', 'timed_out', 'action_required', 'stale']) {
      expect(normalizeCheckRun(check({ conclusion: c }))!.state).toBe('failure');
    }
    expect(normalizeCheckRun(check())!.description).toBe('Deployed');
    expect(normalizeCheckRun({ status: 'completed' })).toBeNull();
  });
});

describe('decideCommitSignal', () => {
  const sig = (over: Partial<CommitSignal>): CommitSignal => ({
    via: 'status',
    name: 'Vercel',
    state: 'success',
    description: '',
    updatedAt: 1,
    ...over,
  });

  it('keeps waiting on nothing or pending', () => {
    expect(decideCommitSignal([])).toBeNull();
    expect(decideCommitSignal([sig({ state: 'pending' })])).toBeNull();
  });

  it('is ready on a clean success', () => {
    expect(decideCommitSignal([sig({ description: 'Deployment has completed' })])).toMatchObject({
      kind: 'ready',
    });
  });

  it("skips a success whose description says the build did not happen (Vercel's Ignored Build Step)", () => {
    for (const d of ['Canceled', 'Deployment ignored', 'Skipped: no changes', 'cancelled']) {
      expect(decideCommitSignal([sig({ description: d })])).toMatchObject({
        kind: 'skip',
        reason: expect.stringContaining('no preview build'),
      });
    }
  });

  it('skips a failure and a skipped/cancelled check run', () => {
    expect(
      decideCommitSignal([sig({ state: 'failure', description: 'Deployment failed' })]),
    ).toMatchObject({ kind: 'skip', reason: 'the status "Vercel" failed: Deployment failed' });
    expect(decideCommitSignal([sig({ via: 'check_run', state: 'skip' })])).toMatchObject({
      kind: 'skip',
      reason: expect.stringContaining('the check "Vercel" reports no preview build'),
    });
  });

  it('of a status and a check run with the same name, the newer one speaks', () => {
    const older = sig({ via: 'status', state: 'failure', updatedAt: 1 });
    const newer = sig({ via: 'check_run', state: 'success', updatedAt: 2 });
    expect(decideCommitSignal([older, newer])).toMatchObject({ kind: 'ready', signal: newer });
    expect(decideCommitSignal([newer, older])).toMatchObject({ kind: 'ready', signal: newer });
    expect(decideCommitSignal([sig({ updatedAt: 3, state: 'pending' }), older])).toBeNull();
  });
});

describe('waitForCommitSignal', () => {
  const target = { repoOwner: 'acme', repoName: 'storefront', sha: 'a'.repeat(40), name: 'Vercel' };

  /**
   * `rounds[i]` answers the i-th poll (a round starts with the `/status` read);
   * the last answer repeats. `status`/`fail` apply to both endpoints,
   * `checksStatus`/`checksFail` to `/check-runs` only; `checksPage2` makes the
   * first check-runs page carry a `Link: rel="next"` to a second page.
   */
  function harness(
    rounds: Array<{
      statuses?: unknown[];
      checks?: unknown[];
      checksPage2?: unknown[];
      status?: number;
      checksStatus?: number;
      headers?: Record<string, string>;
      fail?: boolean;
      checksFail?: boolean;
    }>,
    shutdown?: ShutdownController,
  ) {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const slept: number[] = [];
    const urls: string[] = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    let round = -1;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      signals.push(init?.signal);
      const isChecks = url.includes('/check-runs');
      const isPage2 = /[?&]page=2\b/.test(url);
      if (!isChecks && !isPage2) round++;
      const r = rounds[Math.min(Math.max(round, 0), rounds.length - 1)]!;
      if (isChecks ? (r.checksFail ?? r.fail) : r.fail) throw new Error('ECONNRESET');
      const status = isChecks ? (r.checksStatus ?? r.status) : r.status;
      if (status !== undefined) return new Response('{}', { status, headers: r.headers ?? {} });
      const json = { 'content-type': 'application/json' };
      if (isChecks && r.checksPage2 && !isPage2) {
        return new Response(JSON.stringify({ check_runs: r.checks ?? [] }), {
          status: 200,
          headers: { ...json, link: `<${url}&page=2>; rel="next", <${url}&page=2>; rel="last"` },
        });
      }
      const body = isChecks
        ? { check_runs: isPage2 ? (r.checksPage2 ?? []) : (r.checks ?? []) }
        : { statuses: r.statuses ?? [] };
      return new Response(JSON.stringify(body), { status: 200, headers: json });
    });
    const deps = {
      env: { GITHUB_API_URL: 'https://api.github.com' } as NodeJS.ProcessEnv,
      fetchImpl,
      sleep: async (ms: number) => {
        slept.push(ms);
        now += ms;
      },
      shutdown,
      stderr: vi.fn(),
    };
    return { deps, slept, urls, signals, fetchImpl };
  }

  it('reads both endpoints each round, backs off, and is ready once the status succeeds', async () => {
    const h = harness([
      {},
      { statuses: [status({ state: 'pending' })] },
      { statuses: [status({ state: 'pending' })] },
      { statuses: [status()] },
    ]);
    const verdict = await waitForCommitSignal(target, { token: 'ghs', timeoutMs: 900_000 }, h.deps);
    expect(verdict).toMatchObject({ kind: 'ready', signal: { via: 'status', name: 'Vercel' } });
    expect(h.urls.slice(0, 2)).toEqual([
      `https://api.github.com/repos/acme/storefront/commits/${target.sha}/status?per_page=100`,
      `https://api.github.com/repos/acme/storefront/commits/${target.sha}/check-runs?per_page=100`,
    ]);
    expect(h.slept).toEqual([5_000, 10_000, 20_000]);
    expect(h.fetchImpl.mock.calls[0]![1]).toMatchObject({
      headers: expect.objectContaining({ authorization: 'Bearer ghs' }),
    });
  });

  it('a check run of that name is read the same way (Cloudflare Pages)', async () => {
    const h = harness([
      { checks: [check({ name: 'Vercel', status: 'in_progress', conclusion: null })] },
      { checks: [check({ name: 'Vercel' })] },
    ]);
    await expect(
      waitForCommitSignal(target, { token: 'ghs', timeoutMs: 900_000 }, h.deps),
    ).resolves.toMatchObject({ kind: 'ready', signal: { via: 'check_run' } });
  });

  it('skips on a failed deploy and on a success that built nothing', async () => {
    const failed = harness([
      { statuses: [status({ state: 'failure', description: 'Deployment has failed' })] },
    ]);
    await expect(
      waitForCommitSignal(target, { token: 'ghs', timeoutMs: 900_000 }, failed.deps),
    ).resolves.toMatchObject({
      kind: 'skip',
      reason: 'the status "Vercel" failed: Deployment has failed',
    });
    expect(failed.slept).toEqual([]);

    const ignored = harness([{ statuses: [status({ description: 'Canceled' })] }]);
    await expect(
      waitForCommitSignal(target, { token: 'ghs', timeoutMs: 900_000 }, ignored.deps),
    ).resolves.toMatchObject({ kind: 'skip', reason: expect.stringContaining('Canceled') });
  });

  it('times out with every name it saw, sleeping no further than the deadline', async () => {
    const h = harness([
      {
        statuses: [status({ context: 'Vercle', state: 'pending' })],
        checks: [check({ name: 'TestSprite' })],
      },
    ]);
    const verdict = await waitForCommitSignal(target, { token: 'ghs', timeoutMs: 12_000 }, h.deps);
    expect(verdict).toEqual({ kind: 'timeout', waitedMs: 12_000, seen: ['TestSprite', 'Vercle'] });
    // 5s, then the 7s left — never the full 10s second step.
    expect(h.slept).toEqual([5_000, 7_000]);
  });

  it('a permission answer is a configuration error naming the token permissions', async () => {
    const h = harness([{ status: 403 }]);
    await expect(
      waitForCommitSignal(target, { token: 'ghs', timeoutMs: 900_000 }, h.deps),
    ).rejects.toMatchObject({ exitCode: 5, message: expect.stringContaining('checks: read') });
    expect(h.slept).toEqual([]);
  });

  it('transient answers (network, 5xx) are retried inside the deadline', async () => {
    const h = harness([{ fail: true }, { status: 502 }, { statuses: [status()] }]);
    await expect(
      waitForCommitSignal(target, { token: 'ghs', timeoutMs: 900_000 }, h.deps),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(h.slept).toEqual([5_000, 10_000]);
    expect(h.deps.stderr).toHaveBeenCalled();
  });

  it('a termination signal during the backoff rejects with the InterruptError and disarms', async () => {
    const shutdown = new ShutdownController();
    const h = harness([{ statuses: [status({ state: 'pending' })] }], shutdown);
    h.deps.sleep = async () => {
      shutdown.signal.dispatchEvent(new Event('abort'));
      await new Promise(resolve => setTimeout(resolve, 0));
    };
    const armed = vi.spyOn(shutdown, 'arm');
    // Abort the controller's signal the way the signal handler does.
    vi.spyOn(shutdown, 'signal', 'get').mockReturnValue(
      (() => {
        const c = new AbortController();
        queueMicrotask(() => c.abort(new InterruptError('SIGTERM')));
        return c.signal;
      })(),
    );
    await expect(
      waitForCommitSignal(target, { token: 'ghs', timeoutMs: 900_000 }, h.deps),
    ).rejects.toBeInstanceOf(InterruptError);
    expect(armed).toHaveBeenCalled();
  });

  it('a round with a failed endpoint decides nothing — an older success on /status does not win while /check-runs is unread', async () => {
    const h = harness([
      { statuses: [status()], checksStatus: 502 },
      {
        statuses: [status()],
        checks: [
          check({
            name: 'Vercel',
            status: 'in_progress',
            conclusion: null,
            completed_at: null,
            started_at: '2026-10-23T21:05:00Z',
          }),
        ],
      },
      {
        statuses: [status()],
        checks: [check({ name: 'Vercel', completed_at: '2026-10-23T21:06:00Z' })],
      },
    ]);
    const verdict = await waitForCommitSignal(target, { token: 'ghs', timeoutMs: 900_000 }, h.deps);
    // Round 1 read half → no verdict; round 2 saw the newer pending check → wait; round 3 ready.
    expect(verdict).toMatchObject({ kind: 'ready', signal: { via: 'check_run' } });
    expect(h.slept).toEqual([5_000, 10_000]);

    const reverse = harness([
      { statuses: [status({ state: 'failure', description: 'old' })], checksFail: true },
      {
        statuses: [status({ state: 'failure', description: 'old' })],
        checks: [check({ name: 'Vercel', completed_at: '2026-10-23T21:06:00Z' })],
      },
    ]);
    await expect(
      waitForCommitSignal(target, { token: 'ghs', timeoutMs: 900_000 }, reverse.deps),
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(reverse.slept).toEqual([5_000]);
  });

  it('follows pagination: a target check on page 2 of /check-runs is found', async () => {
    const h = harness([
      {
        checks: [check({ name: 'lint' }), check({ name: 'build' })],
        checksPage2: [check({ name: 'Vercel' })],
      },
    ]);
    const verdict = await waitForCommitSignal(target, { token: 'ghs', timeoutMs: 900_000 }, h.deps);
    expect(verdict).toMatchObject({ kind: 'ready', signal: { via: 'check_run', name: 'Vercel' } });
    expect(h.urls.filter(u => u.includes('/check-runs'))).toEqual([
      `https://api.github.com/repos/acme/storefront/commits/${target.sha}/check-runs?per_page=100`,
      `https://api.github.com/repos/acme/storefront/commits/${target.sha}/check-runs?per_page=100&page=2`,
    ]);
    expect(h.slept).toEqual([]);
    expect(COMMIT_SIGNAL_MAX_PAGES).toBe(10);
  });

  it('nextLink reads the rel="next" URL and nothing else', () => {
    expect(
      nextLink(
        '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"',
      ),
    ).toBe('https://api.github.com/x?page=2');
    expect(nextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(nextLink(null)).toBeNull();
  });

  it('a rate-limited 403 is not a permission error: the cooldown is honored inside the deadline', async () => {
    const h = harness([
      { status: 403, headers: { 'retry-after': '7', 'x-ratelimit-remaining': '0' } },
      { statuses: [status()] },
    ]);
    await expect(
      waitForCommitSignal(target, { token: 'ghs', timeoutMs: 900_000 }, h.deps),
    ).resolves.toMatchObject({ kind: 'ready' });
    // 7 s asked for beats the 5 s first backoff.
    expect(h.slept).toEqual([7_000]);
    expect(h.deps.stderr).toHaveBeenCalledWith(expect.stringContaining('rate limit'));

    // A 429 with only x-ratelimit-reset, and a reset past the deadline.
    const reset = harness([
      {
        status: 429,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(1_000_000 / 1000) + 40),
        },
      },
      { statuses: [status()] },
    ]);
    // 40 s asked for, 12 s left: the wait sleeps to the deadline and is a timeout,
    // never a read GitHub would throttle again.
    await expect(
      waitForCommitSignal(target, { token: 'ghs', timeoutMs: 12_000 }, reset.deps),
    ).resolves.toMatchObject({ kind: 'timeout', waitedMs: 12_000 });
    expect(reset.slept).toEqual([12_000]);
  });

  it('every GitHub read carries the remaining budget as its abort signal', async () => {
    const h = harness([{ statuses: [status()] }]);
    await waitForCommitSignal(target, { token: 'ghs', timeoutMs: 900_000 }, h.deps);
    expect(h.signals).toHaveLength(2);
    for (const s of h.signals) expect(s).toBeInstanceOf(AbortSignal);
  });

  it('a GitHub read that stalls is cut at the deadline and the wait is a timeout, not a hang', async () => {
    // Real clock: the budget's AbortSignal.timeout must fire.
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), {
            once: true,
          });
        }),
    );
    const stderr = vi.fn();
    const startedAt = Date.now();
    const verdict = await waitForCommitSignal(
      target,
      { token: 'ghs', timeoutMs: 80 },
      {
        env: {} as NodeJS.ProcessEnv,
        fetchImpl,
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        stderr,
      },
    );
    expect(verdict).toMatchObject({ kind: 'timeout', seen: [] });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(75);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('remaining --status-timeout budget'),
    );
  });

  it('the backoff table is what the loop walks', () => {
    expect([...COMMIT_SIGNAL_BACKOFF_MS]).toEqual([5_000, 10_000, 20_000, 30_000]);
    expect(new CLIError('x', 5).exitCode).toBe(5);
  });
});
