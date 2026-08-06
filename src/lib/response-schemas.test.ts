/**
 * Dedicated tests for the response schemas (issue #102): the schemas must be
 * loose (additive server fields pass), mirror nullability, and turn drift
 * into a typed INTERNAL envelope at the HttpClient boundary.
 */

import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { HttpClient } from './http.js';
import {
  BATCH_RERUN_RESPONSE_SCHEMA,
  LIST_RUNS_RESPONSE_SCHEMA,
  ME_IDENTITY_SCHEMA,
  RERUN_RESPONSE_SCHEMA,
  RUN_RESPONSE_SCHEMA,
  TRIGGER_RUN_RESPONSE_SCHEMA,
} from './response-schemas.js';

const VALID_RUN = {
  runId: 'run_1',
  testId: 'test_1',
  projectId: 'p_1',
  userId: 'u_1',
  status: 'passed',
  source: 'cli',
  createdAt: '2026-06-01T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  codeVersion: 'v1',
  targetUrl: 'https://example.com',
  createdFrom: null,
  failedStepIndex: null,
  failureKind: null,
  error: null,
  videoUrl: null,
  stepSummary: { total: 0, completed: 0, passedCount: 0, failedCount: 0 },
};

function makeClient(fetchImpl: typeof fetch): HttpClient {
  return new HttpClient({
    baseUrl: 'https://api.example.com/api/cli/v1',
    apiKey: 'sk-test',
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
}

describe('RUN_RESPONSE_SCHEMA', () => {
  it('accepts a valid run and preserves unknown extra keys (additive drift is non-breaking)', () => {
    const parsed = v.safeParse(RUN_RESPONSE_SCHEMA, {
      ...VALID_RUN,
      someFutureField: 'kept',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.output as { someFutureField?: string }).someFutureField).toBe('kept');
    }
  });

  it('rejects a run missing a required field, naming the path', () => {
    const withoutStatus: Record<string, unknown> = { ...VALID_RUN };
    delete withoutStatus.status;
    const parsed = v.safeParse(RUN_RESPONSE_SCHEMA, withoutStatus);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.some(issue => v.getDotPath(issue) === 'status')).toBe(true);
    }
  });

  it('accepts targetUrl: null and keeps it null (backend runs, and any run whose engine records no URL)', () => {
    const parsed = v.safeParse(RUN_RESPONSE_SCHEMA, { ...VALID_RUN, targetUrl: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.targetUrl).toBeNull();
    }
  });

  it('accepts codeVersion: null (pre-M3.1 rows, and tests with no stored code body)', () => {
    const parsed = v.safeParse(RUN_RESPONSE_SCHEMA, { ...VALID_RUN, codeVersion: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.codeVersion).toBeNull();
    }
  });

  it('normalizes an omitted targetUrl / codeVersion to null', () => {
    const withoutBoth: Record<string, unknown> = { ...VALID_RUN };
    delete withoutBoth.targetUrl;
    delete withoutBoth.codeVersion;
    const parsed = v.safeParse(RUN_RESPONSE_SCHEMA, withoutBoth);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.targetUrl).toBeNull();
      expect(parsed.output.codeVersion).toBeNull();
    }
  });

  // The three cases below pin the whole `dashboardUrl` contract at the parse
  // boundary — the only place it can be broken invisibly, since the command
  // tests build `RunResponse` objects by hand and never cross this schema.
  it('leaves an omitted dashboardUrl as an ABSENT key, not a materialized null (keeps the client fallback alive)', () => {
    const parsed = v.safeParse(RUN_RESPONSE_SCHEMA, { ...VALID_RUN });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // `withRunDashboardUrl` branches on `'dashboardUrl' in run`: an absent key
      // means "this backend sends no link, compute one myself". Switching the
      // schema default from `undefined` to `null` (matching the fields above)
      // would make this key always present and turn that fallback into dead
      // code for every older backend.
      expect('dashboardUrl' in parsed.output).toBe(false);
      expect(Object.keys(parsed.output)).not.toContain('dashboardUrl');
    }
  });

  it('accepts dashboardUrl: null without failing validation (a null must never take down `test wait`)', () => {
    const parsed = v.safeParse(RUN_RESPONSE_SCHEMA, { ...VALID_RUN, dashboardUrl: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Preserved as null, not coerced: the default applies to an ABSENT key
      // only. Consumers normalize (a null suppresses the link and does NOT
      // substitute the client guess).
      expect('dashboardUrl' in parsed.output).toBe(true);
      expect(parsed.output.dashboardUrl).toBeNull();
    }
  });

  it('accepts and preserves a server-sent dashboardUrl string', () => {
    const link = 'https://portal.example.com/dashboard-v3/o/org_1/projects/p_1/test-cases/test_1';
    const parsed = v.safeParse(RUN_RESPONSE_SCHEMA, { ...VALID_RUN, dashboardUrl: link });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.dashboardUrl).toBe(link);
    }
  });
});

describe('HttpClient schema hook', () => {
  it('getRun surfaces drift as a typed INTERNAL envelope with issue paths (never a blind cast)', async () => {
    const drifted: Record<string, unknown> = { ...VALID_RUN };
    delete drifted.status;
    const fetchImpl = (async () =>
      new Response(JSON.stringify(drifted), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const client = makeClient(fetchImpl);
    const rejection = await client.getRun('run_1').catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: 'INTERNAL' });
    const issues = (rejection as { getDetail: (key: string) => unknown }).getDetail('issues');
    expect(Array.isArray(issues)).toBe(true);
    expect(JSON.stringify(issues)).toContain('status');
  });

  it('getRun resolves normally when the run carries targetUrl: null (never an INTERNAL envelope)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ...VALID_RUN, targetUrl: null, codeVersion: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const client = makeClient(fetchImpl);
    const run = await client.getRun('run_1');
    expect(run.status).toBe('passed');
    expect(run.targetUrl).toBeNull();
    expect(run.codeVersion).toBeNull();
  });

  it('a schemaless generic get still returns whatever JSON came back (unchanged behavior)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ anything: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(client.get('/me')).resolves.toEqual({ anything: true });
  });
});

describe('TRIGGER_RUN_RESPONSE_SCHEMA', () => {
  it('accepts the queued-run envelope', () => {
    const parsed = v.safeParse(TRIGGER_RUN_RESPONSE_SCHEMA, {
      runId: 'run_1',
      status: 'queued',
      enqueuedAt: '2026-06-01T10:00:00.000Z',
      codeVersion: 'v1',
      targetUrl: 'https://example.com',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('LIST_RUNS_RESPONSE_SCHEMA', () => {
  const HISTORY_ROW = {
    runId: 'run_1',
    status: 'passed',
    source: 'cli',
    isRerun: false,
    createdFrom: null,
    createdAt: '2026-06-01T10:00:00.000Z',
    startedAt: null,
    finishedAt: '2026-06-01T10:00:30.000Z',
    codeVersion: 'v1',
    failureKind: null,
  };

  it('accepts a history row with codeVersion: null (pre-M3.2 rows, tests with no code body)', () => {
    const parsed = v.safeParse(LIST_RUNS_RESPONSE_SCHEMA, {
      runs: [{ ...HISTORY_ROW, codeVersion: null }],
      nextCursor: null,
      meta: {},
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.runs[0]?.codeVersion).toBeNull();
    }
  });

  it('accepts a history row with targetUrl: null + targetUrlSource: null', () => {
    const parsed = v.safeParse(LIST_RUNS_RESPONSE_SCHEMA, {
      runs: [{ ...HISTORY_ROW, targetUrl: null, targetUrlSource: null }],
      nextCursor: null,
      meta: {},
    });
    expect(parsed.success).toBe(true);
  });
});

const VALID_RERUN = {
  runId: 'run_rerun_1',
  status: 'queued',
  enqueuedAt: '2026-06-01T10:00:00.000Z',
  codeVersion: 'v1',
  autoHeal: false,
};

describe('RERUN_RESPONSE_SCHEMA — advisories (optional additive field)', () => {
  it('accepts a response with no advisories field (every V2 response, older backends)', () => {
    const parsed = v.safeParse(RERUN_RESPONSE_SCHEMA, VALID_RERUN);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.output as { advisories?: unknown }).advisories).toBeUndefined();
    }
  });

  it('accepts and preserves advisories when present (V3-routed rerun with autoHeal:false)', () => {
    const parsed = v.safeParse(RERUN_RESPONSE_SCHEMA, {
      ...VALID_RERUN,
      advisories: [
        {
          feature: 'autoHeal',
          message:
            'The auto-heal opt-out was forwarded to the execution engine but is not yet enforced there.',
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.advisories).toEqual([
        {
          feature: 'autoHeal',
          message:
            'The auto-heal opt-out was forwarded to the execution engine but is not yet enforced there.',
        },
      ]);
    }
  });

  it('accepts an empty advisories array', () => {
    const parsed = v.safeParse(RERUN_RESPONSE_SCHEMA, { ...VALID_RERUN, advisories: [] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.advisories).toEqual([]);
    }
  });
});

const VALID_BATCH_RERUN = {
  accepted: [{ testId: 'test_1', runId: 'run_1', enqueuedAt: '2026-06-01T10:00:00.000Z' }],
  deferred: [],
  conflicts: [],
  closure: { byProject: [] },
};

describe('BATCH_RERUN_RESPONSE_SCHEMA — advisories (optional additive field)', () => {
  it('accepts a response with no advisories field', () => {
    const parsed = v.safeParse(BATCH_RERUN_RESPONSE_SCHEMA, VALID_BATCH_RERUN);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.output as { advisories?: unknown }).advisories).toBeUndefined();
    }
  });

  it('accepts and preserves advisories when present', () => {
    const parsed = v.safeParse(BATCH_RERUN_RESPONSE_SCHEMA, {
      ...VALID_BATCH_RERUN,
      advisories: [{ feature: 'autoHeal', message: 'not yet enforced' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.advisories).toEqual([
        { feature: 'autoHeal', message: 'not yet enforced' },
      ]);
    }
  });
});

describe('ME_IDENTITY_SCHEMA', () => {
  it('accepts a bare identity core with no org fields (older backend)', () => {
    const parsed = v.safeParse(ME_IDENTITY_SCHEMA, { userId: 'u_1', keyId: 'k_1' });
    expect(parsed.success).toBe(true);
  });

  it('accepts organizations[] and org together (membership key)', () => {
    const parsed = v.safeParse(ME_IDENTITY_SCHEMA, {
      userId: 'u_1',
      keyId: 'k_1',
      organizations: [
        { id: 'org_1', name: 'Acme Corp', role: 'owner', isPersonal: false },
        { id: 'org_2', name: "u_1's workspace", role: 'owner', isPersonal: true },
      ],
      org: { id: 'org_1', name: 'Acme Corp', role: 'owner' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts org.name === null (best-effort resolution failed server-side)', () => {
    const parsed = v.safeParse(ME_IDENTITY_SCHEMA, {
      org: { id: 'org_1', name: null, role: 'member' },
    });
    expect(parsed.success).toBe(true);
  });

  it('preserves unknown extra keys on the full /me projection (loose object)', () => {
    const parsed = v.safeParse(ME_IDENTITY_SCHEMA, {
      userId: 'u_1',
      keyId: 'k_1',
      scopes: ['read:me'],
      env: 'development',
      v3Enabled: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.output as { v3Enabled?: boolean }).v3Enabled).toBe(true);
    }
  });

  it('rejects a malformed organizations entry (missing role)', () => {
    const parsed = v.safeParse(ME_IDENTITY_SCHEMA, {
      organizations: [{ id: 'org_1', name: 'Acme Corp', isPersonal: false }],
    });
    expect(parsed.success).toBe(false);
  });
});
