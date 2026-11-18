/**
 * What `ci run` can learn about the pull request it is gating, from the
 * GitHub Actions runner alone — no secrets of ours, no flags in the yml.
 *
 * A `pull_request` event names the PR in its payload. A `deployment_status`
 * event (the platform-deploys-every-PR shape) only names the commit, so the
 * PR is looked up with the job's own `GITHUB_TOKEN` through the same call the
 * GitHub App makes (`GET /repos/{owner}/{repo}/commits/{sha}/pulls`). A run
 * that cannot be tied to a pull request is reported as such, never guessed:
 * the caller decides whether that means "skip" or "run without a preview".
 */
import { readFileSync } from 'node:fs';
import { CLIError, localValidationError } from './errors.js';
import type { FetchImpl } from './http.js';
import type { CiGithubTrigger } from './runs.types.js';

export type GithubRunContext =
  | { kind: 'pull_request'; trigger: CiGithubTrigger; draft: boolean }
  | { kind: 'no_pull_request'; event: string; reason: string }
  | { kind: 'outside_actions' };

export interface GithubContextDeps {
  /** Reads `$GITHUB_EVENT_PATH`; injectable so tests never touch the runner. */
  readFile?: (path: string) => string;
  fetchImpl?: FetchImpl;
  /** Budget for the GitHub pull-request lookup, as `--request-timeout` gives every other call. */
  requestTimeoutMs?: number;
}

/** Same default as the HttpClient's per-request budget when no flag or env var sets one. */
const DEFAULT_LOOKUP_TIMEOUT_MS = 30_000;

/** The temporary environment a pull request's runs live in — shared with the GitHub App. */
export function previewEnvironmentName(prNumber: number): string {
  return `github-pr-${prNumber}`;
}

const SHA_RE = /^[0-9a-f]{40}$/;

export async function readGithubRunContext(
  env: NodeJS.ProcessEnv,
  deps: GithubContextDeps = {},
): Promise<GithubRunContext> {
  if (env.GITHUB_ACTIONS !== 'true') return { kind: 'outside_actions' };
  const event = env.GITHUB_EVENT_NAME ?? '';
  const slug = env.GITHUB_REPOSITORY ?? '';
  const [repoOwner, repoName, ...rest] = slug.split('/');
  if (!repoOwner || !repoName || rest.length > 0) {
    return { kind: 'no_pull_request', event, reason: 'GITHUB_REPOSITORY is not owner/name' };
  }
  const payload = readEvent(env, deps);

  if (event === 'pull_request' || event === 'pull_request_target') {
    const pr = asRecord(payload.pull_request);
    const prNumber = pr?.number;
    if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber < 1) {
      throw localValidationError(
        'github-event-path',
        `the ${event} event at $GITHUB_EVENT_PATH carries no pull_request.number`,
        undefined,
        'field',
      );
    }
    const head = asRecord(pr?.head);
    return {
      kind: 'pull_request',
      draft: pr?.draft === true,
      trigger: {
        repoOwner,
        repoName,
        prNumber,
        ...(typeof head?.ref === 'string' && head.ref !== '' ? { branchName: head.ref } : {}),
        ...(typeof head?.sha === 'string' && SHA_RE.test(head.sha) ? { commitSha: head.sha } : {}),
      },
    };
  }

  if (event === 'deployment_status') {
    const deployment = asRecord(payload.deployment);
    const sha = typeof deployment?.sha === 'string' ? deployment.sha : '';
    if (!SHA_RE.test(sha)) {
      return { kind: 'no_pull_request', event, reason: 'the deployment names no commit' };
    }
    const token = env.GITHUB_TOKEN;
    if (!token) {
      throw localValidationError(
        'GITHUB_TOKEN',
        'a deployment_status event names only a commit; ci run looks up its pull request with the job token — add `GITHUB_TOKEN: ${{ github.token }}` to the step env',
        undefined,
        'field',
      );
    }
    const pulls = await listPullsForCommit(
      {
        env,
        repoOwner,
        repoName,
        sha,
        token,
        timeoutMs: deps.requestTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS,
      },
      deps.fetchImpl ?? globalThis.fetch,
    );
    // Only an OPEN PR whose head IS this commit is the one this deployment belongs to.
    // Anything looser (an open PR that merely contains the commit, a merged or closed one) is
    // not a gate target: a redeploy of a merged PR's head commit must not clone an environment.
    const chosen = pulls.find(p => p.headSha === sha && p.state === 'open');
    if (!chosen) {
      return {
        kind: 'no_pull_request',
        event,
        reason:
          pulls.length === 0
            ? `commit ${sha.slice(0, 7)} belongs to no pull request`
            : `commit ${sha.slice(0, 7)} is not the head of an open pull request`,
      };
    }
    const branch = typeof deployment?.ref === 'string' ? deployment.ref : chosen.headRef;
    return {
      kind: 'pull_request',
      draft: chosen.draft,
      trigger: {
        repoOwner,
        repoName,
        prNumber: chosen.number,
        commitSha: sha,
        ...(branch ? { branchName: branch } : {}),
      },
    };
  }

  return {
    kind: 'no_pull_request',
    event,
    reason: `a ${event || 'non-PR'} event has no pull request`,
  };
}

function readEvent(env: NodeJS.ProcessEnv, deps: GithubContextDeps): Record<string, unknown> {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) return {};
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- `path` is the runner-provided `$GITHUB_EVENT_PATH` env path (read-only), never API/test content.
  const read = deps.readFile ?? (p => readFileSync(p, 'utf8'));
  try {
    const parsed: unknown = JSON.parse(read(path));
    return asRecord(parsed) ?? {};
  } catch (err) {
    throw localValidationError(
      'github-event-path',
      `cannot read the GitHub event at $GITHUB_EVENT_PATH: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      'field',
    );
  }
}

interface PullSummary {
  number: number;
  state: string;
  draft: boolean;
  headSha: string;
  headRef?: string;
}

async function listPullsForCommit(
  args: {
    env: NodeJS.ProcessEnv;
    repoOwner: string;
    repoName: string;
    sha: string;
    token: string;
    timeoutMs: number;
  },
  fetchImpl: FetchImpl,
): Promise<PullSummary[]> {
  const base = (args.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
  const url = `${base}/repos/${encodeURIComponent(args.repoOwner)}/${encodeURIComponent(args.repoName)}/commits/${args.sha}/pulls`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${args.token}`,
        'x-github-api-version': '2022-11-28',
      },
      // Without a budget a GitHub API that never answers hangs the job until the runner kills it.
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (err) {
    throw new CLIError(
      `Could not look up the pull request for commit ${args.sha.slice(0, 7)}: ` +
        (isTimeout(err)
          ? `GitHub did not answer within ${Math.round(args.timeoutMs / 1000)}s`
          : err instanceof Error
            ? err.message
            : String(err)),
      10,
    );
  }
  if (!response.ok) {
    throw new CLIError(
      `Could not look up the pull request for commit ${args.sha.slice(0, 7)}: GitHub answered ${response.status}` +
        (response.status === 403 || response.status === 401
          ? ' — the job token needs `pull-requests: read`'
          : ''),
      response.status === 401 || response.status === 403 ? 5 : 10,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    // A proxy or captive portal answering 200 with HTML must be a transient failure, not an uncaught crash; so is
    // a body that stalls until the timeout aborts it, which is reported as the timeout it is, and a connection that
    // drops mid-body, which is reported with its own cause rather than as "not JSON".
    throw new CLIError(
      `Could not look up the pull request for commit ${args.sha.slice(0, 7)}: ` +
        (isTimeout(err)
          ? `GitHub did not finish answering within ${Math.round(args.timeoutMs / 1000)}s`
          : err instanceof SyntaxError
            ? `GitHub answered ${response.status} with a body that is not JSON`
            : `GitHub's ${response.status} response body could not be read: ${err instanceof Error ? err.message : String(err)}`),
      10,
    );
  }
  if (!Array.isArray(body)) return [];
  return body.flatMap((item): PullSummary[] => {
    const pr = asRecord(item);
    const head = asRecord(pr?.head);
    if (typeof pr?.number !== 'number' || typeof head?.sha !== 'string') return [];
    return [
      {
        number: pr.number,
        state: typeof pr.state === 'string' ? pr.state : '',
        draft: pr.draft === true,
        headSha: head.sha,
        ...(typeof head.ref === 'string' ? { headRef: head.ref } : {}),
      },
    ];
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}
