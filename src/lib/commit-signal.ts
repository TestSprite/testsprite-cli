/**
 * `ci run --wait-for-status <name>`: hold the run until the deploy platform
 * says this commit's preview exists.
 *
 * With a `pull_request` trigger the workflow starts the moment the platform
 * starts building, so a run dispatched at once tests an address that is not
 * serving yet — or one that was never going to be built (an ignored build, a
 * failed deploy). The platform does write one signal on the head commit, and
 * GitHub has two APIs for it, chosen by the platform's integration: a
 * **commit status** (`GET /commits/{sha}/status`, keyed by `context`; Vercel,
 * Netlify, Render) or a **check run** (`GET /commits/{sha}/check-runs`, keyed
 * by `name`; Cloudflare Pages, every Actions job). They render identically on
 * the pull request, so the CLI keeps no table of who writes which: every poll
 * reads both, matches `<name>` exactly against either key, and normalizes
 * whichever answered. The only platform-specific input is the name itself,
 * copied off a recent pull request at setup time.
 *
 * Verdicts: `ready` (success, nothing says the build was skipped), `skip`
 * (failed, errored, or success-but-Ignored/Canceled/Skipped — Vercel's Ignored
 * Build Step writes success + "Canceled"), `timeout` (nothing terminal before
 * the deadline, with every name seen on the commit so a misspelling is
 * obvious). A `skip` is "no preview, tests not run" — the caller exits 0 and
 * never falls back to production or the environment URL.
 */
import { CLIError, InterruptError } from './errors.js';
import type { FetchImpl } from './http.js';
import type { ShutdownHandle } from './interrupt.js';

export type CommitSignalState = 'pending' | 'success' | 'failure' | 'skip';

export interface CommitSignal {
  via: 'status' | 'check_run';
  name: string;
  state: CommitSignalState;
  description: string;
  /** When the platform last wrote it; decides between a status and a check run of the same name. */
  updatedAt: number;
}

export type CommitSignalVerdict =
  | { kind: 'ready'; signal: CommitSignal }
  | { kind: 'skip'; signal: CommitSignal; reason: string }
  | { kind: 'timeout'; waitedMs: number; seen: string[] };

export interface CommitSignalTarget {
  repoOwner: string;
  repoName: string;
  /** The pull request's head commit — never the merge commit `GITHUB_SHA`. */
  sha: string;
  /** Matched exactly against `statuses[].context` and `check_runs[].name`. */
  name: string;
}

export interface CommitSignalDeps {
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchImpl;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  shutdown?: ShutdownHandle;
  stderr?: (line: string) => void;
}

/** Backoff between polls: a build is minutes, not milliseconds. */
export const COMMIT_SIGNAL_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000] as const;

/** Descriptions a platform writes on a `success` that produced no preview. */
const NO_PREVIEW_RE = /\b(ignored|canceled|cancelled|skipped)\b/i;

export function normalizeStatus(record: Record<string, unknown>): CommitSignal | null {
  const name = typeof record.context === 'string' ? record.context : null;
  if (name === null) return null;
  const raw = typeof record.state === 'string' ? record.state : 'pending';
  const state: CommitSignalState =
    raw === 'success' ? 'success' : raw === 'failure' || raw === 'error' ? 'failure' : 'pending';
  return {
    via: 'status',
    name,
    state,
    description: typeof record.description === 'string' ? record.description : '',
    updatedAt: parseTime(record.updated_at),
  };
}

export function normalizeCheckRun(record: Record<string, unknown>): CommitSignal | null {
  const name = typeof record.name === 'string' ? record.name : null;
  if (name === null) return null;
  const output = asRecord(record.output);
  const description = typeof output?.title === 'string' ? output.title : '';
  const updatedAt = parseTime(record.completed_at) || parseTime(record.started_at);
  if (record.status !== 'completed') {
    return { via: 'check_run', name, state: 'pending', description, updatedAt };
  }
  const conclusion = typeof record.conclusion === 'string' ? record.conclusion : '';
  const state: CommitSignalState =
    conclusion === 'success' || conclusion === 'neutral'
      ? 'success'
      : conclusion === 'skipped' || conclusion === 'cancelled'
        ? 'skip'
        : 'failure';
  return { via: 'check_run', name, state, description, updatedAt };
}

/**
 * The verdict one round of reads yields, or `null` to keep waiting. Of a
 * status and a check run with the same name, the newer one speaks.
 */
export function decideCommitSignal(
  signals: CommitSignal[],
): Exclude<CommitSignalVerdict, { kind: 'timeout' }> | null {
  const newest = signals.reduce<CommitSignal | null>(
    (best, s) => (best === null || s.updatedAt > best.updatedAt ? s : best),
    null,
  );
  if (newest === null || newest.state === 'pending') return null;
  const what = newest.via === 'status' ? 'status' : 'check';
  const detail = newest.description ? `: ${newest.description}` : '';
  if (newest.state === 'failure') {
    return { kind: 'skip', signal: newest, reason: `the ${what} "${newest.name}" failed${detail}` };
  }
  if (newest.state === 'skip' || NO_PREVIEW_RE.test(newest.description)) {
    return {
      kind: 'skip',
      signal: newest,
      reason: `the ${what} "${newest.name}" reports no preview build${detail}`,
    };
  }
  return { kind: 'ready', signal: newest };
}

/** Pages followed per endpoint per round; a preview check is never past this. */
export const COMMIT_SIGNAL_MAX_PAGES = 10;

/**
 * Poll both endpoints until `target.name` is terminal or `timeoutMs` passes.
 * The deadline bounds everything: each GitHub read (request and body) gets
 * the remaining budget as its own timeout, so a stalled connection cannot
 * outlive `--status-timeout` and no success can arrive after it. Every sleep
 * is clamped to the deadline and cut short by a termination signal (the
 * graceful-detach scope is armed for the wait).
 */
export async function waitForCommitSignal(
  target: CommitSignalTarget,
  opts: { token: string; timeoutMs: number },
  deps: CommitSignalDeps,
): Promise<CommitSignalVerdict> {
  const startedAt = Date.now();
  const deadline = startedAt + opts.timeoutMs;
  const seen = new Set<string>();
  const timedOut = (): CommitSignalVerdict => ({
    kind: 'timeout',
    waitedMs: Date.now() - startedAt,
    seen: [...seen].sort(),
  });
  const disarm = deps.shutdown?.arm();
  try {
    for (let attempt = 0; ; attempt++) {
      let remaining = deadline - Date.now();
      if (remaining <= 0) return timedOut();
      const round = await readCommitSignals(target, opts.token, deps, remaining);
      for (const name of round.names) seen.add(name);
      // A round with a failed read decides nothing: the endpoint that did
      // answer may hold an older record of the same name, and the newer one
      // speaks. The next round, inside the same deadline, reads both again.
      if (round.complete) {
        const verdict = decideCommitSignal(round.matched);
        if (verdict) return verdict;
      }
      remaining = deadline - Date.now();
      if (remaining <= 0) return timedOut();
      const backoff =
        COMMIT_SIGNAL_BACKOFF_MS[Math.min(attempt, COMMIT_SIGNAL_BACKOFF_MS.length - 1)]!;
      // A rate-limited answer names its own cooldown; honor it, inside the deadline.
      await sleepOrInterrupt(Math.min(Math.max(backoff, round.retryAfterMs ?? 0), remaining), deps);
    }
  } finally {
    disarm?.();
  }
}

/**
 * One round: both endpoints (every page), the records named `target.name`,
 * every name seen, and whether both reads answered. `retryAfterMs` is the
 * longest cooldown a rate-limited answer asked for.
 */
async function readCommitSignals(
  target: CommitSignalTarget,
  token: string,
  deps: CommitSignalDeps,
  budgetMs: number,
): Promise<{ matched: CommitSignal[]; names: string[]; complete: boolean; retryAfterMs?: number }> {
  const base = (deps.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
  const repo = `${base}/repos/${encodeURIComponent(target.repoOwner)}/${encodeURIComponent(target.repoName)}/commits/${target.sha}`;
  const [statuses, checks] = await Promise.all([
    githubList(`${repo}/status?per_page=100`, 'statuses', token, deps, budgetMs),
    githubList(`${repo}/check-runs?per_page=100`, 'check_runs', token, deps, budgetMs),
  ]);
  const matched: CommitSignal[] = [];
  const names: string[] = [];
  const collect = (
    rows: unknown[] | null,
    normalize: (record: Record<string, unknown>) => CommitSignal | null,
  ): void => {
    for (const row of rows ?? []) {
      const record = asRecord(row);
      const signal = record ? normalize(record) : null;
      if (!signal) continue;
      names.push(signal.name);
      if (signal.name === target.name) matched.push(signal);
    }
  };
  collect(statuses.rows, normalizeStatus);
  collect(checks.rows, normalizeCheckRun);
  const retryAfterMs = Math.max(statuses.retryAfterMs ?? 0, checks.retryAfterMs ?? 0);
  return {
    matched,
    names,
    complete: statuses.rows !== null && checks.rows !== null,
    ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
  };
}

interface GithubListResult {
  /** Every row of `key` across the pages read; `null` when any page could not be read. */
  rows: unknown[] | null;
  retryAfterMs?: number;
}

/** A paginated list: follows `Link: rel="next"` up to `COMMIT_SIGNAL_MAX_PAGES`, inside `budgetMs`. */
async function githubList(
  url: string,
  key: 'statuses' | 'check_runs',
  token: string,
  deps: CommitSignalDeps,
  budgetMs: number,
): Promise<GithubListResult> {
  const startedAt = Date.now();
  const rows: unknown[] = [];
  let next: string | null = url;
  for (let page = 0; next !== null && page < COMMIT_SIGNAL_MAX_PAGES; page++) {
    const left = budgetMs - (Date.now() - startedAt);
    if (left <= 0) return { rows: null };
    const read = await githubGet(next, token, deps, left);
    if (!read.ok) {
      return {
        rows: null,
        ...(read.retryAfterMs !== undefined ? { retryAfterMs: read.retryAfterMs } : {}),
      };
    }
    const list = asRecord(read.body)?.[key];
    if (Array.isArray(list)) rows.push(...list);
    next = read.next;
  }
  return { rows };
}

type GithubGetResult =
  { ok: true; body: unknown; next: string | null } | { ok: false; retryAfterMs?: number };

/**
 * One GitHub read, bounded by `budgetMs` (request and body). A permission
 * answer is a configuration error, named with the permission the job token
 * lacks; a rate-limited 403/429 is transient with its cooldown; anything else
 * transient (network, the budget, 5xx) is `ok: false` — this round learns
 * nothing and the next one tries again, inside the same deadline.
 */
async function githubGet(
  url: string,
  token: string,
  deps: CommitSignalDeps,
  budgetMs: number,
): Promise<GithubGetResult> {
  const budget = AbortSignal.timeout(Math.max(1, budgetMs));
  const signal = deps.shutdown ? AbortSignal.any([deps.shutdown.signal, budget]) : budget;
  const interrupted = (): never => {
    throw deps.shutdown!.signal.reason;
  };
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      signal,
    });
  } catch (err) {
    if (err instanceof InterruptError) throw err;
    if (deps.shutdown?.signal.aborted) interrupted();
    deps.stderr?.(
      budget.aborted
        ? '[ci run] GitHub did not answer within the remaining --status-timeout budget'
        : `[ci run] could not read the commit's checks (${err instanceof Error ? err.message : String(err)}); retrying`,
    );
    return { ok: false };
  }
  if (isRateLimited(response)) {
    const retryAfterMs = rateLimitCooldownMs(response.headers);
    deps.stderr?.(
      `[ci run] GitHub rate limit reached reading the commit's checks; retrying${
        retryAfterMs !== undefined ? ` after ${Math.ceil(retryAfterMs / 1000)}s` : ''
      }`,
    );
    return { ok: false, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new CLIError(
      `Could not read the checks on this commit: GitHub answered ${response.status} — the job token needs \`statuses: read\` and \`checks: read\` (add them under \`permissions:\`, and keep \`GITHUB_TOKEN: \${{ github.token }}\` in the step env).`,
      5,
    );
  }
  if (!response.ok) {
    deps.stderr?.(
      `[ci run] GitHub answered ${response.status} reading the commit's checks; retrying`,
    );
    return { ok: false };
  }
  try {
    const body = (await response.json()) as unknown;
    return { ok: true, body, next: nextLink(response.headers.get('link')) };
  } catch {
    if (deps.shutdown?.signal.aborted) interrupted();
    return { ok: false };
  }
}

/** GitHub throttles with 403 or 429 plus `retry-after` or an exhausted `x-ratelimit-remaining`. */
function isRateLimited(response: Response): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  return (
    response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'
  );
}

/** The cooldown a throttled answer asks for: `retry-after` seconds, else until `x-ratelimit-reset`. */
function rateLimitCooldownMs(headers: Headers): number | undefined {
  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const ms = reset * 1000 - Date.now();
    if (ms > 0) return ms;
  }
  return undefined;
}

/** The `rel="next"` URL of a `Link` header, or `null` on the last page. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  const match = /<([^>]+)>\s*;\s*rel="next"/.exec(link);
  return match ? match[1]! : null;
}

function sleepOrInterrupt(ms: number, deps: CommitSignalDeps): Promise<void> {
  const signal = deps.shutdown?.signal;
  if (signal === undefined) return deps.sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    deps.sleep(ms, signal).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      err => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function parseTime(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
