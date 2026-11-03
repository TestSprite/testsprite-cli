/**
 * Deployment-linkage diagnosis for `ci doctor`.
 *
 * A deployment-gated workflow (`on: deployment_status`) only ever fires if the
 * repo actually RECEIVES GitHub Deployment events. Those records are written by
 * whatever deploys the app — Vercel's own GitHub App writes a `deployment` plus
 * a `deployment_status`, GitHub broadcasts the event, and every subscriber
 * (our workflow, the TestSprite GitHub App) sees the same one.
 *
 * When the deploy platform is not git-linked to the repo, nothing is ever
 * written, so nothing ever fires — with no error anywhere. Measured on a real
 * repo: the app deploys fine on Vercel while the repo's Deployments list is
 * empty, which would leave a scaffolded gate permanently silent. This module
 * turns that invisible state into a verdict.
 *
 * Pure functions only: the `gh`/`git` subprocess calls live in `commands/ci.ts`
 * so this stays trivially testable.
 */

/** How old the newest deployment may be before the link looks abandoned. */
const STALE_AFTER_DAYS = 90;

/** One GitHub Deployment record, reduced to what the verdict needs. */
export interface DeploymentRecord {
  /** GitHub's environment label — "Preview", "Production", "preview", … */
  environment: string;
  /** ISO timestamp the record was created. */
  createdAt: string;
  /** Login that wrote the record (`vercel[bot]`, a user, a CI app). */
  creator: string | null;
}

export type LinkageStatus =
  /** Recent records exist — events reach this repo, a gate will fire. */
  | 'linked'
  /** Records exist but all are old — the link may have been removed since. */
  | 'stale'
  /** Records exist but none for a preview environment — a PR gate never fires. */
  | 'production-only'
  /** No records at all — either not linked, or linked and never deployed. */
  | 'none';

export interface LinkageVerdict {
  status: LinkageStatus;
  /**
   * Whether a deployment-gated workflow is safe to scaffold. Only `linked`
   * qualifies: every other status means the gate would be silent or partial,
   * which is the failure this check exists to prevent.
   */
  ok: boolean;
  /** One-line human explanation, ready to print. */
  detail: string;
  /**
   * Timestamp of the record the verdict is ABOUT — the newest preview record
   * for `linked`/`stale`, the newest record overall for `production-only` —
   * or null when there are none.
   */
  lastDeployAt: string | null;
  /** Distinct creators seen, newest first — names who is writing the events. */
  creators: string[];
  /** Whether any record targets a preview environment. */
  hasPreview: boolean;
}

/** GitHub labels Vercel previews "Preview"; other platforms vary in case. */
function isPreviewEnvironment(environment: string): boolean {
  const env = environment.toLowerCase();
  return env.includes('preview') || env.includes('staging');
}

function daysBetween(fromIso: string, now: Date): number {
  const then = new Date(fromIso).getTime();
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then) / 86_400_000;
}

/** "3 days ago" / "5 months ago", for the human line. */
export function describeAge(iso: string, now: Date): string {
  const days = daysBetween(iso, now);
  if (!Number.isFinite(days)) return 'at an unknown time';
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 45) return `${Math.round(days)} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

/**
 * Turn a repo's deployment history into a verdict.
 *
 * Deliberately NOT Vercel-specific on the success path: the event is the same
 * whoever writes it, so a repo fed by Netlify, a self-hosted pipeline, or a
 * hand-rolled `gh api` call reads as linked just the same. The creator is
 * reported, not required.
 *
 * `records` may be in any order; the newest is picked here.
 */
export function classifyLinkage(records: readonly DeploymentRecord[], now: Date): LinkageVerdict {
  if (records.length === 0) {
    return {
      status: 'none',
      ok: false,
      // The two causes are indistinguishable from GitHub's side — we cannot
      // query another App's installations — so the verdict names both rather
      // than guessing. `ci connect` resolves either one the same way.
      detail:
        'No deployment events on this repo. Either the deploy platform is not linked to it, ' +
        'or it is linked and has not deployed yet — a deployment-gated workflow would never fire.',
      lastDeployAt: null,
      creators: [],
      hasPreview: false,
    };
  }

  const sorted = [...records].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const creators = [...new Set(sorted.map(r => r.creator).filter((c): c is string => !!c))];

  // Classify per environment, never off the newest record overall. A repo that
  // deploys production daily but whose last preview is months old would
  // otherwise read as freshly `linked` — and a gate scaffolded on that verdict
  // never fires, which is the exact silent failure this classifier exists to
  // catch. (Boundary this accepts: a repo whose whole fetched page is
  // production deploys newer than its last preview reads `production-only`
  // rather than `stale` — both mean "no PR gate", not worth paging for.)
  const previews = sorted.filter(r => isPreviewEnvironment(r.environment));

  if (previews.length === 0) {
    const newest = sorted[0]!;
    const age = describeAge(newest.createdAt, now);
    const by = newest.creator ? ` by ${newest.creator}` : '';
    return {
      status: 'production-only',
      ok: false,
      // A PR gate keys on preview deployments; production-only records mean the
      // workflow would fire on releases and never on a pull request.
      detail:
        `Only production deployment events on this repo (newest ${age}${by}), none for a preview environment. ` +
        'A PR gate keys on preview deployments — enable preview deployments on your deploy platform.',
      lastDeployAt: newest.createdAt,
      creators,
      hasPreview: false,
    };
  }

  const newestPreview = previews[0]!;
  const age = describeAge(newestPreview.createdAt, now);
  const by = newestPreview.creator ? ` by ${newestPreview.creator}` : '';

  if (daysBetween(newestPreview.createdAt, now) > STALE_AFTER_DAYS) {
    return {
      status: 'stale',
      ok: false,
      detail:
        `Preview deployment events exist, but the newest is from ${age}${by}. ` +
        'The link may have been removed since — push a commit and re-check before relying on a gate.',
      lastDeployAt: newestPreview.createdAt,
      creators,
      hasPreview: true,
    };
  }

  return {
    status: 'linked',
    ok: true,
    detail: `Preview deployment events reach this repo (newest preview ${age}${by}).`,
    lastDeployAt: newestPreview.createdAt,
    creators,
    hasPreview: true,
  };
}

/**
 * Whether a string is safe to use as an `owner/repo` slug in a `gh api` path.
 * The character class matches what GitHub itself allows in owner/repo names,
 * but admits `.`/`..` — which as path SEGMENTS would make `repos/../../…`
 * resolve to a different endpoint — so those are refused explicitly.
 */
export function isValidRepoSlug(slug: string): boolean {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) return false;
  return slug.split('/').every(segment => segment !== '.' && segment !== '..');
}

/**
 * `owner/repo` from a git remote URL. Handles the three shapes a cloned repo
 * actually carries — SSH (`git@github.com:o/r.git`), HTTPS, and the `ssh://`
 * form — and returns null for anything not on github.com, since a GitLab or
 * Bitbucket remote has no GitHub Deployments to read.
 */
export function parseRepoSlug(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  if (!url) return null;
  const match =
    /^git@github\.com:(?<slug>[^/]+\/[^/]+?)(?:\.git)?$/.exec(url) ??
    /^ssh:\/\/git@github\.com\/(?<slug>[^/]+\/[^/]+?)(?:\.git)?$/.exec(url) ??
    /^https?:\/\/(?:[^@]+@)?github\.com\/(?<slug>[^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  const slug = match?.groups?.slug;
  if (!slug) return null;
  return isValidRepoSlug(slug) ? slug : null;
}

/**
 * Reduce `gh api .../deployments` output to `DeploymentRecord`s. Tolerates the
 * field being absent or oddly typed: a diagnosis must not crash on a payload
 * shape change, it should just report what it could read.
 */
export function parseDeploymentsPayload(raw: string): DeploymentRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return (
    parsed
      .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
      .map(row => {
        const creator = row.creator;
        const login =
          creator !== null && typeof creator === 'object'
            ? (creator as { login?: unknown }).login
            : undefined;
        return {
          environment: typeof row.environment === 'string' ? row.environment : '',
          createdAt: typeof row.created_at === 'string' ? row.created_at : '',
          creator: typeof login === 'string' ? login : null,
        };
      })
      // A row without a PARSEABLE timestamp can't be aged or ordered — one NaN
      // in the sort comparator would make the whole ordering implementation-
      // defined — so it is dropped rather than silently treated as epoch.
      .filter(r => Number.isFinite(new Date(r.createdAt).getTime()))
  );
}
