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
