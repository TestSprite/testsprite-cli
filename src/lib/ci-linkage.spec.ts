import { describe, expect, it } from 'vitest';
import {
  classifyLinkage,
  describeAge,
  isValidRepoSlug,
  parseDeploymentsPayload,
  parseRepoSlug,
  type DeploymentRecord,
} from './ci-linkage.js';

const NOW = new Date('2026-09-16T00:00:00.000Z');

function rec(over: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    environment: 'Preview',
    createdAt: '2026-09-15T00:00:00.000Z',
    creator: 'vercel[bot]',
    ...over,
  };
}

describe('classifyLinkage', () => {
  it('recent preview events → linked (a gate will fire)', () => {
    const v = classifyLinkage([rec()], NOW);
    expect(v.status).toBe('linked');
    expect(v.ok).toBe(true);
    expect(v.creators).toEqual(['vercel[bot]']);
    expect(v.detail).toContain('yesterday');
  });

  it('the creator is reported, never required — a non-Vercel writer still counts', () => {
    // The event is the same whoever writes it: Netlify, a self-hosted pipeline
    // posting via the API, or a person. Gating on `vercel[bot]` would wrongly
    // fail every one of those.
    const v = classifyLinkage([rec({ creator: 'my-deploy-bot' })], NOW);
    expect(v.status).toBe('linked');
    expect(v.detail).toContain('my-deploy-bot');
  });

  it('no records → none, and names BOTH possible causes rather than guessing', () => {
    const v = classifyLinkage([], NOW);
    expect(v.status).toBe('none');
    expect(v.ok).toBe(false);
    // From GitHub's side "never linked" and "linked, never deployed" are
    // indistinguishable — the copy must not assert one of them.
    expect(v.detail).toContain('not linked');
    expect(v.detail).toContain('has not deployed yet');
    expect(v.lastDeployAt).toBeNull();
  });

  it('only old records → stale (the link may have been removed since)', () => {
    const v = classifyLinkage([rec({ createdAt: '2026-01-01T00:00:00.000Z' })], NOW);
    expect(v.status).toBe('stale');
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('months ago');
  });

  it('daily production deploys do NOT freshen a months-old preview — still stale', () => {
    // The false `linked` this classifier used to report: staleness judged on
    // the newest record overall, while `hasPreview` looked at all of history.
    // A repo that ships production daily but whose last preview is six months
    // old must read stale — a gate scaffolded on `linked` there never fires.
    const v = classifyLinkage(
      [
        rec({
          environment: 'Production',
          createdAt: '2026-09-15T00:00:00.000Z',
          creator: 'ship-bot',
        }),
        rec({ createdAt: '2026-03-01T00:00:00.000Z', creator: 'vercel[bot]' }),
      ],
      NOW,
    );
    expect(v.status).toBe('stale');
    expect(v.ok).toBe(false);
    // age/by come from the newest PREVIEW record, not the newest overall —
    // "newest today" next to a stale verdict would contradict itself.
    expect(v.detail).toContain('months ago');
    expect(v.detail).toContain('vercel[bot]');
    expect(v.lastDeployAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('a fresh preview stays linked however old the production history around it is', () => {
    const v = classifyLinkage(
      [rec(), rec({ environment: 'Production', createdAt: '2025-01-01T00:00:00.000Z' })],
      NOW,
    );
    expect(v.status).toBe('linked');
    expect(v.ok).toBe(true);
  });

  it('production-only records → not ok: a PR gate keys on preview deployments', () => {
    const v = classifyLinkage(
      [rec({ environment: 'Production' }), rec({ environment: 'production' })],
      NOW,
    );
    expect(v.status).toBe('production-only');
    expect(v.ok).toBe(false);
    expect(v.hasPreview).toBe(false);
    expect(v.detail).toContain('preview');
  });

  it('a mixed history counts as linked when any record is a preview', () => {
    const v = classifyLinkage([rec({ environment: 'Production' }), rec()], NOW);
    expect(v.status).toBe('linked');
    expect(v.hasPreview).toBe(true);
  });

  it('picks the newest record regardless of input order', () => {
    const v = classifyLinkage(
      [
        rec({ createdAt: '2026-01-01T00:00:00.000Z', creator: 'old-bot' }),
        rec({ createdAt: '2026-09-15T12:00:00.000Z', creator: 'new-bot' }),
      ],
      NOW,
    );
    expect(v.status).toBe('linked'); // newest is recent → not stale
    expect(v.lastDeployAt).toBe('2026-09-15T12:00:00.000Z');
    expect(v.creators[0]).toBe('new-bot');
  });
});

describe('parseRepoSlug', () => {
  it('reads the three remote shapes a cloned repo actually carries', () => {
    expect(parseRepoSlug('git@github.com:acme/storefront.git')).toBe('acme/storefront');
    expect(parseRepoSlug('https://github.com/acme/storefront.git')).toBe('acme/storefront');
    expect(parseRepoSlug('ssh://git@github.com/acme/storefront')).toBe('acme/storefront');
    expect(parseRepoSlug('  https://github.com/acme/storefront/  \n')).toBe('acme/storefront');
    expect(parseRepoSlug('https://x-access-token:tok@github.com/acme/storefront.git')).toBe(
      'acme/storefront',
    );
  });

  it('returns null for non-GitHub remotes (no GitHub Deployments to read)', () => {
    expect(parseRepoSlug('git@gitlab.com:acme/storefront.git')).toBeNull();
    expect(parseRepoSlug('https://bitbucket.org/acme/storefront.git')).toBeNull();
    expect(parseRepoSlug('')).toBeNull();
  });

  it('refuses a slug carrying path or flag syntax (it is interpolated into a gh path)', () => {
    expect(parseRepoSlug('git@github.com:acme/store front.git')).toBeNull();
    expect(parseRepoSlug('https://github.com/acme/../../etc')).toBeNull();
  });
});

describe('isValidRepoSlug', () => {
  it('accepts what GitHub allows in owner/repo names', () => {
    expect(isValidRepoSlug('acme/storefront')).toBe(true);
    expect(isValidRepoSlug('acme-inc/store.front_2')).toBe(true);
  });

  it('refuses `.`/`..` segments the character class alone admits', () => {
    // `repos/../../user` would be a DIFFERENT gh endpoint, not a repo read.
    expect(isValidRepoSlug('../..')).toBe(false);
    expect(isValidRepoSlug('./repo')).toBe(false);
    expect(isValidRepoSlug('owner/..')).toBe(false);
  });

  it('refuses shapes that are not exactly owner/name', () => {
    expect(isValidRepoSlug('acme')).toBe(false);
    expect(isValidRepoSlug('acme/store/front')).toBe(false);
    expect(isValidRepoSlug('acme/store front')).toBe(false);
  });
});

describe('parseDeploymentsPayload', () => {
  it('reduces the gh payload to records', () => {
    const raw = JSON.stringify([
      {
        environment: 'Preview',
        created_at: '2026-09-15T00:00:00Z',
        creator: { login: 'vercel[bot]' },
      },
      { environment: 'Production', created_at: '2026-09-14T00:00:00Z', creator: null },
    ]);
    const records = parseDeploymentsPayload(raw);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ environment: 'Preview', creator: 'vercel[bot]' });
    expect(records[1]!.creator).toBeNull();
  });

  it('never throws on a shape it did not expect — a diagnosis must still report', () => {
    expect(parseDeploymentsPayload('not json')).toEqual([]);
    expect(parseDeploymentsPayload('{"message":"Not Found"}')).toEqual([]);
    expect(parseDeploymentsPayload('[null, 42]')).toEqual([]);
    // A row without a usable timestamp can't be aged, so it is dropped rather
    // than silently treated as epoch (which would read as "stale").
    expect(parseDeploymentsPayload('[{"environment":"Preview"}]')).toEqual([]);
  });

  it('drops rows whose timestamp does not parse — one NaN would poison the sort', () => {
    const raw = JSON.stringify([
      { environment: 'Preview', created_at: 'not-a-date', creator: null },
      { environment: 'Preview', created_at: '2026-09-15T00:00:00Z', creator: null },
    ]);
    const records = parseDeploymentsPayload(raw);
    expect(records).toHaveLength(1);
    expect(records[0]!.createdAt).toBe('2026-09-15T00:00:00Z');
  });
});

describe('describeAge', () => {
  it('reads like a human, not a timestamp', () => {
    expect(describeAge('2026-09-15T23:00:00.000Z', NOW)).toBe('today');
    expect(describeAge('2026-09-15T00:00:00.000Z', NOW)).toBe('yesterday');
    expect(describeAge('2026-09-01T00:00:00.000Z', NOW)).toBe('15 days ago');
    expect(describeAge('2026-03-16T00:00:00.000Z', NOW)).toBe('6 months ago');
    expect(describeAge('nonsense', NOW)).toBe('at an unknown time');
  });
});
