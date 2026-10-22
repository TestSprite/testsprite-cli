import { describe, expect, it, vi } from 'vitest';
import { previewEnvironmentName, readGithubRunContext } from './github-context.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function actionsEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'acme/storefront',
    GITHUB_EVENT_PATH: '/runner/event.json',
    ...over,
  };
}

function eventFile(payload: unknown) {
  return { readFile: vi.fn().mockReturnValue(JSON.stringify(payload)) };
}

function githubApi(pulls: unknown, status = 200) {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void url;
    void init;
    return new Response(JSON.stringify(pulls), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>;
  return fetchImpl;
}

describe('readGithubRunContext', () => {
  it('is outside_actions when GITHUB_ACTIONS is not true', async () => {
    await expect(readGithubRunContext({ GITHUB_EVENT_NAME: 'pull_request' })).resolves.toEqual({
      kind: 'outside_actions',
    });
  });

  it('reads a pull_request event from the event file', async () => {
    const ctx = await readGithubRunContext(
      actionsEnv({ GITHUB_EVENT_NAME: 'pull_request' }),
      eventFile({ pull_request: { number: 42, draft: false, head: { sha: SHA, ref: 'feat/x' } } }),
    );
    expect(ctx).toEqual({
      kind: 'pull_request',
      draft: false,
      trigger: {
        repoOwner: 'acme',
        repoName: 'storefront',
        prNumber: 42,
        branchName: 'feat/x',
        commitSha: SHA,
      },
    });
  });

  it('reports a draft pull request as such (the caller decides to skip)', async () => {
    const ctx = await readGithubRunContext(
      actionsEnv({ GITHUB_EVENT_NAME: 'pull_request' }),
      eventFile({ pull_request: { number: 7, draft: true, head: { sha: SHA } } }),
    );
    expect(ctx).toMatchObject({ kind: 'pull_request', draft: true });
  });

  it('refuses a pull_request event without a number, and an unreadable event file', async () => {
    await expect(
      readGithubRunContext(
        actionsEnv({ GITHUB_EVENT_NAME: 'pull_request' }),
        eventFile({ pull_request: {} }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      readGithubRunContext(actionsEnv({ GITHUB_EVENT_NAME: 'pull_request' }), {
        readFile: () => 'not json',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('deployment_status: looks the PR up by commit with the job token, preferring the exact head', async () => {
    const fetchImpl = githubApi([
      { number: 41, state: 'open', draft: false, head: { sha: OTHER, ref: 'other' } },
      { number: 42, state: 'open', draft: false, head: { sha: SHA, ref: 'feat/x' } },
    ]);
    const ctx = await readGithubRunContext(
      actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status', GITHUB_TOKEN: 'ghs_token' }),
      { ...eventFile({ deployment: { sha: SHA, ref: 'feat/x' } }), fetchImpl },
    );
    expect(ctx).toEqual({
      kind: 'pull_request',
      draft: false,
      trigger: {
        repoOwner: 'acme',
        repoName: 'storefront',
        prNumber: 42,
        commitSha: SHA,
        branchName: 'feat/x',
      },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/acme/storefront/commits/${SHA}/pulls`);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ghs_token');
  });

  it('deployment_status: no pull request for the commit is a reported fact, not an error', async () => {
    const ctx = await readGithubRunContext(
      actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status', GITHUB_TOKEN: 't' }),
      { ...eventFile({ deployment: { sha: SHA } }), fetchImpl: githubApi([]) },
    );
    expect(ctx).toMatchObject({ kind: 'no_pull_request', event: 'deployment_status' });
    // A commit that is only the head of a CLOSED pull request is not a gate target.
    const closed = await readGithubRunContext(
      actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status', GITHUB_TOKEN: 't' }),
      {
        ...eventFile({ deployment: { sha: SHA } }),
        fetchImpl: githubApi([{ number: 3, state: 'closed', head: { sha: OTHER } }]),
      },
    );
    expect(closed.kind).toBe('no_pull_request');
    // Nor is a merged/closed pull request whose head IS the deployed commit (a redeploy after merge).
    for (const state of ['closed', 'merged']) {
      const done = await readGithubRunContext(
        actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status', GITHUB_TOKEN: 't' }),
        {
          ...eventFile({ deployment: { sha: SHA } }),
          fetchImpl: githubApi([{ number: 7, state, head: { sha: SHA, ref: 'feat/done' } }]),
        },
      );
      expect(done).toMatchObject({ kind: 'no_pull_request', event: 'deployment_status' });
    }
    // Nor an open PR that only contains the commit (branched off it): its head is another commit.
    const containing = await readGithubRunContext(
      actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status', GITHUB_TOKEN: 't' }),
      {
        ...eventFile({ deployment: { sha: SHA } }),
        fetchImpl: githubApi([
          { number: 7, state: 'closed', head: { sha: SHA, ref: 'feat/done' } },
          { number: 8, state: 'open', head: { sha: OTHER, ref: 'feat/next' } },
        ]),
      },
    );
    expect(containing).toMatchObject({ kind: 'no_pull_request', event: 'deployment_status' });
  });

  it('deployment_status: an open PR wins over a closed one with the same head commit', async () => {
    const ctx = await readGithubRunContext(
      actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status', GITHUB_TOKEN: 't' }),
      {
        ...eventFile({ deployment: { sha: SHA } }),
        fetchImpl: githubApi([
          { number: 7, state: 'closed', head: { sha: SHA, ref: 'feat/old' } },
          { number: 9, state: 'open', head: { sha: SHA, ref: 'feat/new' } },
        ]),
      },
    );
    expect(ctx).toMatchObject({ kind: 'pull_request', trigger: { prNumber: 9 } });
  });

  it('deployment_status: a lookup that never answers times out with exit 10 instead of hanging', async () => {
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof globalThis.fetch;
    const started = Date.now();
    await expect(
      readGithubRunContext(
        actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status', GITHUB_TOKEN: 't' }),
        {
          ...eventFile({ deployment: { sha: SHA } }),
          fetchImpl: hang,
          requestTimeoutMs: 50,
        },
      ),
    ).rejects.toMatchObject({
      exitCode: 10,
      message: expect.stringContaining('did not answer within'),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('deployment_status: a 200 whose body stalls past the timeout is reported as a timeout, exit 10', async () => {
    const stall = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }) as unknown as typeof globalThis.fetch;
    await expect(
      readGithubRunContext(
        actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status', GITHUB_TOKEN: 't' }),
        { ...eventFile({ deployment: { sha: SHA } }), fetchImpl: stall, requestTimeoutMs: 50 },
      ),
    ).rejects.toMatchObject({
      exitCode: 10,
      message: expect.stringContaining('did not finish answering within'),
    });
  });

  it('deployment_status: a 200 that is not JSON (proxy, captive portal) is exit 10, not an uncaught crash', async () => {
    const html = vi.fn(
      async () =>
        new Response('<html>sign in to the proxy</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      readGithubRunContext(
        actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status', GITHUB_TOKEN: 't' }),
        {
          ...eventFile({ deployment: { sha: SHA } }),
          fetchImpl: html,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 10, message: expect.stringContaining('not JSON') });
  });

  it('deployment_status: a body that breaks off mid-stream is exit 10 with its cause, not "not JSON"', async () => {
    const broken = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('[{"number":'));
              controller.error(new Error('socket hang up'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof globalThis.fetch;
    const failure = readGithubRunContext(
      actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status', GITHUB_TOKEN: 't' }),
      { ...eventFile({ deployment: { sha: SHA } }), fetchImpl: broken },
    );
    await expect(failure).rejects.toMatchObject({
      exitCode: 10,
      message: expect.stringContaining('could not be read: socket hang up'),
    });
    await expect(failure).rejects.not.toMatchObject({
      message: expect.stringContaining('not JSON'),
    });
  });

  it('deployment_status: needs GITHUB_TOKEN, and a failed lookup never falls back to a guess', async () => {
    await expect(
      readGithubRunContext(
        actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status' }),
        eventFile({ deployment: { sha: SHA } }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      readGithubRunContext(
        actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status', GITHUB_TOKEN: 't' }),
        { ...eventFile({ deployment: { sha: SHA } }), fetchImpl: githubApi({}, 500) },
      ),
    ).rejects.toMatchObject({ exitCode: 10 });
    await expect(
      readGithubRunContext(
        actionsEnv({ GITHUB_EVENT_NAME: 'deployment_status', GITHUB_TOKEN: 't' }),
        { ...eventFile({ deployment: { sha: SHA } }), fetchImpl: githubApi({}, 403) },
      ),
    ).rejects.toMatchObject({ exitCode: 5 });
  });

  it('other events carry no pull request', async () => {
    const ctx = await readGithubRunContext(
      actionsEnv({ GITHUB_EVENT_NAME: 'push' }),
      eventFile({ ref: 'refs/heads/main' }),
    );
    expect(ctx).toMatchObject({ kind: 'no_pull_request', event: 'push' });
  });

  it('names the preview environment the way the GitHub App does', () => {
    expect(previewEnvironmentName(42)).toBe('github-pr-42');
  });
});
