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
}

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
      { env, repoOwner, repoName, sha, token },
      deps.fetchImpl ?? globalThis.fetch,
    );
    // The PR whose head IS this commit is the one this deployment belongs to.
    // Anything looser (several open PRs, a merged one) is not a gate target.
    const exact = pulls.filter(p => p.headSha === sha);
    const open = pulls.filter(p => p.state === 'open');
    const chosen = exact[0] ?? (open.length === 1 ? open[0] : undefined);
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
  args: { env: NodeJS.ProcessEnv; repoOwner: string; repoName: string; sha: string; token: string },
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
    });
  } catch (err) {
    throw new CLIError(
      `Could not look up the pull request for commit ${args.sha.slice(0, 7)}: ${err instanceof Error ? err.message : String(err)}`,
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
  const body: unknown = await response.json();
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
