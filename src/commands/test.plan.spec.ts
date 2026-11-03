/**
 * Unit tests for `test plan generate` / `test plan accept`.
 *
 * All HTTP is mocked via `makeFetch` / `makeCreds` (same harness as
 * test.run.spec.ts); the ladder's sleep is injected as an instant no-op.
 * Ladder mechanics themselves are covered in `src/lib/plan-poll.spec.ts` —
 * this file covers the command layer: flag surface, renderers, the §3.3
 * `--only` safety matrix, the §7 error-reason → exact-fix texts, the typed
 * exit-7 timeout conversion, dry-run (zero fetch calls), and the signal
 * detach.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, InterruptError, RequestTimeoutError } from '../lib/errors.js';
import { ShutdownController } from '../lib/interrupt.js';
import { resetDryRunBannerForTesting } from '../lib/client-factory.js';
import type { FetchImpl } from '../lib/http.js';
import type {
  CliGeneratePlansResponse,
  CliGetPlansResponse,
  CliPlanProposal,
} from '../lib/plans.types.js';
import { PLAN_GENERATION_STAGES } from '../lib/plans.types.js';
import { MAX_TRIGGER_POSTS_TOTAL } from '../lib/plan-poll.js';
import {
  runPlanGenerate,
  runPlanAccept,
  createTestCommand,
  renderPlanGenerateResultText,
} from './test.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function makeCreds(
  apiKey = 'sk-user-test',
  apiUrl = 'http://localhost:13599',
): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-dev384-plan-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- `dir` is this test's own mkdtempSync-created temp dir, not user input.
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- credentials fixture written into the same mkdtempSync temp dir, not user input.
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath };
}

const PROJECT_ID = 'project_plans_1';

function accepted(
  stage: CliGeneratePlansResponse['stage'],
  stagesRemaining: CliGeneratePlansResponse['stagesRemaining'],
): CliGeneratePlansResponse {
  return {
    status: 'accepted',
    projectId: PROJECT_ID,
    stage,
    stagesRemaining,
    enqueuedAt: '2026-07-28T09:00:00.000Z',
  };
}

function proposal(
  id: string,
  type: 'frontend' | 'backend' = 'frontend',
  extra: Partial<CliPlanProposal> = {},
): CliPlanProposal {
  return {
    proposalId: id,
    title: `Proposal ${id}`,
    description: 'desc',
    priority: 'p1',
    category: 'auth',
    feature: 'login',
    type,
    ...extra,
  };
}

const STAGED: CliPlanProposal[] = [
  proposal('prop_1', 'frontend', {
    steps: [{ type: 'action', description: 'Log in' }],
  }),
  proposal('prop_2', 'backend', {
    endpointPath: '/v1/orders',
    captures: ['orderId'],
    consumes: ['authToken'],
  }),
  proposal('prop_3', 'frontend'),
];

function stagedPlans(
  proposals: CliPlanProposal[] = STAGED,
  credits: CliGetPlansResponse['credits'] = {
    charged: [
      { action: 'strategy', amount: 1 },
      { action: 'proposals', amount: 2 },
    ],
    balance: 147,
  },
): CliGetPlansResponse {
  return {
    generation: { status: 'idle', errorCode: null, errorMessage: null },
    proposals,
    credits,
  };
}

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Scripted plans backend. `triggers` answer POST plans/generate in order
 * (last repeats); `reads` answer GET plans in order (last repeats);
 * `accept` answers POST plans/accept. Any entry may be an error descriptor
 * `{ status, body }`.
 */
function makePlanBackend(script: {
  triggers?: Array<{ status?: number; body: unknown }>;
  reads?: Array<{ status?: number; body: unknown }>;
  accept?: { status?: number; body: unknown };
}): { fetchImpl: FetchImpl; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let t = 0;
  let r = 0;
  const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body });

    let resp: { status?: number; body: unknown } | undefined;
    if (method === 'POST' && url.includes('/plans/generate')) {
      const script0 = script.triggers ?? [];
      resp = script0[Math.min(t, script0.length - 1)];
      t += 1;
    } else if (method === 'POST' && url.includes('/plans/accept')) {
      resp = script.accept;
    } else if (method === 'GET' && url.includes('/plans')) {
      const script0 = script.reads ?? [];
      resp = script0[Math.min(r, script0.length - 1)];
      r += 1;
    }
    if (!resp) throw new Error(`Unexpected request in test: ${method} ${url}`);
    return new Response(JSON.stringify(resp.body), {
      status: resp.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as FetchImpl;
  return { fetchImpl, calls };
}

function errorBody(
  status: number,
  code: string,
  details: Record<string, unknown> = {},
  nextAction = '',
): { status: number; body: unknown } {
  return {
    status,
    body: {
      error: { code, message: `Error: ${code}`, nextAction, requestId: 'req_test', details },
    },
  };
}

interface Capture {
  stdout: string[];
  stderr: string[];
}

function makeDeps(
  fetchImpl: FetchImpl,
  capture: Capture,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...makeCreds(),
    fetchImpl,
    stdout: (line: string) => capture.stdout.push(line),
    stderr: (line: string) => capture.stderr.push(line),
    sleep: () => Promise.resolve(),
    shutdown: new ShutdownController(),
    // Deterministic env so the host's TESTSPRITE_PROJECT_ID never leaks in.
    env: {},
    ...extra,
  };
}

function baseOpts(overrides: Record<string, unknown> = {}): {
  profile: string;
  output: 'json' | 'text';
  dryRun: boolean;
  debug: boolean;
  verbose: boolean;
  projectId?: string;
  timeoutSeconds: number;
  [k: string]: unknown;
} {
  return {
    profile: 'default',
    output: 'json',
    dryRun: false,
    debug: false,
    verbose: false,
    projectId: PROJECT_ID,
    timeoutSeconds: 60,
    ...overrides,
  } as ReturnType<typeof baseOpts>;
}

afterEach(() => {
  resetDryRunBannerForTesting();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

describe('test plan — generate/accept surface', () => {
  it('exposes generate and accept under the plan group', () => {
    const test = createTestCommand();
    const plan = test.commands.find(c => c.name() === 'plan')!;
    const names = plan.commands.map(c => c.name()).sort();
    expect(names).toEqual(['accept', 'generate', 'put']);
  });

  it('generate has --project, --timeout, --idempotency-key flags', () => {
    const test = createTestCommand();
    const plan = test.commands.find(c => c.name() === 'plan')!;
    const generate = plan.commands.find(c => c.name() === 'generate')!;
    const flags = generate.options.map(o => o.long);
    expect(flags).toContain('--project');
    expect(flags).toContain('--timeout');
    expect(flags).toContain('--idempotency-key');
  });

  it('accept has --project, --only, --idempotency-key flags', () => {
    const test = createTestCommand();
    const plan = test.commands.find(c => c.name() === 'plan')!;
    const accept = plan.commands.find(c => c.name() === 'accept')!;
    const flags = accept.options.map(o => o.long);
    expect(flags).toContain('--project');
    expect(flags).toContain('--only');
    expect(flags).toContain('--idempotency-key');
  });
});

// ---------------------------------------------------------------------------
// Generate — happy paths
// ---------------------------------------------------------------------------

describe('runPlanGenerate — happy path', () => {
  it('drives the ladder to staged proposals and prints JSON parity output', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: accepted('proposals', []) }],
      reads: [
        {
          body: {
            ...stagedPlans([]),
            generation: { status: 'proposing', errorCode: null, errorMessage: null },
          },
        },
        { body: stagedPlans() },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const result = await runPlanGenerate(baseOpts(), makeDeps(backend.fetchImpl, capture) as never);

    const printed = JSON.parse(capture.stdout.join('\n')) as Record<string, unknown>;
    expect(printed.projectId).toBe(PROJECT_ID);
    expect((printed.proposals as unknown[]).length).toBe(3);
    expect((printed.generation as { status: string }).status).toBe('idle');
    expect(printed).toEqual(result);
    // The trigger carried an auto-minted cli-plan-gen idempotency key.
    const trigger = backend.calls.find(c => c.url.includes('/plans/generate'))!;
    expect(trigger.method).toBe('POST');
  });

  it('text mode renders the table with stable proposal ids + credits + next lines', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: accepted('proposals', []) }],
      // First read = the F1 pre-trigger baseline (nothing charged yet);
      // the settled read's lifetime block minus it = this run's spend (3).
      reads: [{ body: stagedPlans([], { charged: [], balance: 150 }) }, { body: stagedPlans() }],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanGenerate(
      baseOpts({ output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    const text = capture.stdout.join('\n');
    expect(text).toContain('3 test-case proposals staged for review');
    expect(text).toContain('(credits used: 3, balance: 147)');
    // Every staged proposal's stable id is printed (accept --only consumes it).
    expect(text).toContain('prop_1');
    expect(text).toContain('prop_2');
    expect(text).toContain('prop_3');
    expect(text).toContain('ID');
    expect(text).toContain('PRIORITY');
    expect(text).toContain(`testsprite test plan accept --project ${PROJECT_ID}`);
    expect(text).toContain('--only <id ...>');
  });

  it('credits line degrades gracefully when the best-effort block is absent', async () => {
    // Built literally (not via stagedPlans, whose default parameter would
    // re-fill credits): the wire simply has no credits field.
    const plans: CliGetPlansResponse = {
      generation: { status: 'idle', errorCode: null, errorMessage: null },
      proposals: STAGED,
    };
    const backend = makePlanBackend({
      triggers: [{ body: accepted('proposals', []) }],
      reads: [{ body: plans }],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanGenerate(
      baseOpts({ output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    const text = capture.stdout.join('\n');
    expect(text).toContain('3 test-case proposals staged for review');
    expect(text).not.toContain('credits used');
    expect(text).not.toContain('balance');
  });

  it('skippedCategories on the proposals trigger reaches text AND json output', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: { ...accepted('proposals', []), skippedCategories: 2 } }],
      reads: [{ body: stagedPlans([], { charged: [], balance: 150 }) }, { body: stagedPlans() }],
    });
    const text: Capture = { stdout: [], stderr: [] };
    await runPlanGenerate(baseOpts({ output: 'text' }), makeDeps(backend.fetchImpl, text) as never);
    const out = text.stdout.join('\n');
    expect(out).toContain('3 test-case proposals staged for review');
    expect(out).toContain('note: 2 strategy categories skipped');

    const backend2 = makePlanBackend({
      triggers: [{ body: { ...accepted('proposals', []), skippedCategories: 2 } }],
      reads: [{ body: stagedPlans([], { charged: [], balance: 150 }) }, { body: stagedPlans() }],
    });
    const json: Capture = { stdout: [], stderr: [] };
    const result = (await runPlanGenerate(
      baseOpts(),
      makeDeps(backend2.fetchImpl, json) as never,
    )) as Record<string, unknown>;
    expect(result.skippedCategories).toBe(2);
  });

  it('the note still prints when zero proposals were staged, worded for nothing staged', () => {
    // Renderer-level: the ladder never settles on idle+empty after the
    // proposals rung (it polls to staged/failed/timeout), so this branch is
    // pinned directly. The skip count matters most here — it points at the
    // strategy rather than inviting a re-run that bills again.
    const text = renderPlanGenerateResultText(stagedPlans([]), PROJECT_ID, 2, 2);
    expect(text).toContain('0 test-case proposals staged');
    expect(text).toContain('note: 2 strategy categories skipped');
    expect(text).toContain('Review the strategy in the Portal before re-running');
    expect(text).not.toContain('the proposals above cover the rest');
    expect(text).toContain(`testsprite test plan generate --project ${PROJECT_ID}`);
  });

  it('no skippedCategories key and no note when nothing was skipped', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: accepted('proposals', []) }],
      reads: [{ body: stagedPlans([], { charged: [], balance: 150 }) }, { body: stagedPlans() }],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const result = (await runPlanGenerate(
      baseOpts(),
      makeDeps(backend.fetchImpl, capture) as never,
    )) as Record<string, unknown>;
    expect('skippedCategories' in result).toBe(false);
    expect(capture.stdout.join('\n')).not.toContain('skipped');
  });

  // `credits used` is THIS invocation's spend (settled − pre-trigger
  // baseline), never the wire block's lifetime total.
  it('nothing_to_start re-run: lifetime charges do NOT print as credits used (delta 0)', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: { ...accepted(null, []), status: 'nothing_to_start' } }],
      // Baseline and settled read are the same staged batch: lifetime
      // charged = 3, but this run charged nothing.
      reads: [{ body: stagedPlans() }],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const result = await runPlanGenerate(
      baseOpts({ output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    const text = capture.stdout.join('\n');
    expect(text).toContain('3 test-case proposals staged for review');
    expect(text).not.toContain('credits used');
    expect(text).toContain('balance: 147');
    expect((result as { creditsUsedThisInvocation: unknown }).creditsUsedThisInvocation).toBe(0);
  });

  it('JSON payload carries creditsUsedThisInvocation (null when the baseline read failed)', async () => {
    let reads = 0;
    const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : (input as { url: string }).url;
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/plans/generate')) {
        return new Response(JSON.stringify(accepted('proposals', [])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      reads += 1;
      if (reads === 1) {
        // Baseline read fails (404 — not retried by http.ts, unlike a 5xx) —
        // best-effort: the command must still succeed, with the figure
        // omitted rather than a lifetime number shown.
        return new Response(
          JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              message: 'boom',
              nextAction: '',
              requestId: 'req_x',
              details: {},
            },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(stagedPlans()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as FetchImpl;
    const capture: Capture = { stdout: [], stderr: [] };
    const result = await runPlanGenerate(baseOpts(), makeDeps(fetchImpl, capture) as never);
    const printed = JSON.parse(capture.stdout.join('\n')) as Record<string, unknown>;
    expect(printed.creditsUsedThisInvocation).toBeNull();
    expect(printed).toEqual(result);
  });

  // A facade-side billing failure degrades the wire block to
  // `{charged: [], balance: null}` — charged is DEFINED there, so the
  // undefined-guard alone would diff the settled lifetime totals against an
  // empty baseline and resurrect the misreport above (the lifetime total
  // printed as this invocation's spend). balance: null marks the degraded
  // read; the figure must be omitted, not invented.
  it('degraded baseline credits block (charged: [], balance: null) yields null, never the lifetime total', async () => {
    let reads = 0;
    const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : (input as { url: string }).url;
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/plans/generate')) {
        return new Response(JSON.stringify(accepted('proposals', [])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      reads += 1;
      const body =
        reads === 1
          ? stagedPlans(STAGED, { charged: [], balance: null }) // degraded baseline
          : stagedPlans(); // settled read carries the LIFETIME charges (1+2)
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as FetchImpl;
    const capture: Capture = { stdout: [], stderr: [] };
    const result = await runPlanGenerate(baseOpts(), makeDeps(fetchImpl, capture) as never);
    const printed = JSON.parse(capture.stdout.join('\n')) as Record<string, unknown>;
    expect(printed.creditsUsedThisInvocation).toBeNull();
    expect(printed).toEqual(result);
  });

  it('renders the empty-proposals shape without crashing (post-accept race)', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: { ...accepted(null, []), status: 'nothing_to_start' } }],
      reads: [{ body: stagedPlans([]) }],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanGenerate(
      baseOpts({ output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    const text = capture.stdout.join('\n');
    expect(text).toContain('0 test-case proposals staged');
    expect(text).toContain(`testsprite test plan generate --project ${PROJECT_ID}`);
  });

  it('missing --project exits 5 with a local validation error naming the env var', async () => {
    const backend = makePlanBackend({});
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(
      baseOpts({ projectId: undefined }),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    expect((err as ApiError).exitCode).toBe(5);
    expect((err as ApiError).nextAction).toContain('TESTSPRITE_PROJECT_ID');
    expect(backend.calls).toHaveLength(0);
  });

  // The plan leaves must honor TESTSPRITE_PROJECT_ID through the same house
  // helpers as every other command.
  it('picks up TESTSPRITE_PROJECT_ID when --project is absent', async () => {
    const backend = makePlanBackend({});
    const capture: Capture = { stdout: [], stderr: [] };
    const result = await runPlanGenerate(
      baseOpts({ projectId: undefined, dryRun: true }),
      makeDeps(backend.fetchImpl, capture, {
        env: { TESTSPRITE_PROJECT_ID: 'p_from_env' },
      }) as never,
    );
    expect((result as { projectId: string }).projectId).toBe('p_from_env');
    expect(backend.calls).toHaveLength(0);
  });

  it('--project wins over TESTSPRITE_PROJECT_ID', async () => {
    const backend = makePlanBackend({});
    const capture: Capture = { stdout: [], stderr: [] };
    const result = await runPlanGenerate(
      baseOpts({ dryRun: true }),
      makeDeps(backend.fetchImpl, capture, {
        env: { TESTSPRITE_PROJECT_ID: 'p_from_env' },
      }) as never,
    );
    expect((result as { projectId: string }).projectId).toBe(PROJECT_ID);
  });
});

// ---------------------------------------------------------------------------
// Generate — hint + credentials warning
// ---------------------------------------------------------------------------

describe('runPlanGenerate — first-run hint and credentials warning', () => {
  it('full pipeline: hint names all stages but quotes NO price; exploration warns about test-account sign-in', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: accepted('exploration', ['strategy', 'proposals']) }],
      reads: [
        {
          body: {
            generation: {
              status: 'exploring',
              progress: { resourcesReady: 3, resourcesTotal: 8 },
              errorCode: null,
              errorMessage: null,
            },
            proposals: [],
            credits: { charged: [], balance: null },
          },
        },
        { body: stagedPlans() },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanGenerate(
      baseOpts({ output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    const stderr = capture.stderr.join('\n');
    expect(stderr).toContain(
      '[hint] 3 stages: exploration, strategy, proposals. Takes minutes. Ctrl-C is safe; re-run to continue.',
    );
    // No price is announced up front — the surface matches `test run`, which
    // quotes no cost either. Spend is reported AFTER the fact on the result
    // line (`credits used: N, balance: M`), covered by the render tests above.
    expect(stderr).not.toMatch(/up to \d+ credits/);
    expect(stderr).not.toMatch(/\d+-credit/);
    // The §3.1 warning: warn, never block — the ladder still ran to success.
    expect(stderr).toContain('[warn]');
    expect(stderr).toContain('test account');
    expect(stderr).toContain('still runs and still bills');
    // The remedy is the CLI's own flags (they arm login server-side
    // now), with the real project id substituted — not a Portal trip.
    expect(stderr).toContain(
      'testsprite project update project_plans_1 --username <user> --password-file <path>',
    );
    expect(stderr).not.toContain('Portal');
  });

  it('already-explored project: hint names only the missing stages; no credentials warning', async () => {
    const backend = makePlanBackend({
      triggers: [
        { body: accepted('strategy', ['proposals']) },
        { body: accepted('proposals', []) },
      ],
      reads: [
        {
          body: {
            generation: { status: 'strategizing', errorCode: null, errorMessage: null },
            proposals: [],
            credits: { charged: [], balance: null },
          },
        },
        { body: stagedPlans([]) },
        { body: stagedPlans() },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanGenerate(
      baseOpts({ output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    const stderr = capture.stderr.join('\n');
    expect(stderr).toContain(
      '[hint] 2 stages: strategy, proposals. Ctrl-C is safe; re-run to continue.',
    );
    expect(stderr).not.toMatch(/up to \d+ credits/);
    expect(stderr).not.toContain('exploration');
    expect(stderr).not.toContain('[warn]');
  });

  it('nothing_to_start on the first trigger prints the already-staged advisory', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: { ...accepted(null, []), status: 'nothing_to_start' } }],
      reads: [{ body: stagedPlans() }],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanGenerate(
      baseOpts({ output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    const stderr = capture.stderr.join('\n');
    expect(stderr).toContain('[advisory] proposals are already staged');
    expect(stderr).toContain('nothing new was started or charged');
  });

  it('JSON mode suppresses the hint (but the warn still goes to stderr)', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: accepted('exploration', ['strategy', 'proposals']) }],
      reads: [{ body: stagedPlans() }],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanGenerate(baseOpts(), makeDeps(backend.fetchImpl, capture) as never);
    const stderr = capture.stderr.join('\n');
    expect(stderr).not.toContain('[hint]');
    expect(stderr).toContain('[warn]');
    // stdout stays pure JSON.
    expect(() => JSON.parse(capture.stdout.join('\n'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Generate — failure, timeout, interrupt
// ---------------------------------------------------------------------------

describe('runPlanGenerate — failed stage', () => {
  it('prints the failed block and exits 1 via a typed INTERNAL envelope', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: accepted('strategy', ['proposals']) }],
      reads: [
        {
          body: {
            generation: {
              status: 'failed',
              errorCode: 'strategy_generation_stale',
              errorMessage: 'strategy generation crashed',
            },
            proposals: [],
            credits: { charged: [], balance: null },
          },
        },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(
      baseOpts(),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INTERNAL');
    expect((err as ApiError).exitCode).toBe(1);
    expect((err as ApiError).message).toContain('strategy generation crashed');
    expect((err as ApiError).nextAction).toContain('Completed stages stay done');
    // JSON parity: the failed read still lands on stdout for consumers.
    const printed = JSON.parse(capture.stdout.join('\n')) as {
      generation: { status: string; errorCode: string };
    };
    expect(printed.generation.status).toBe('failed');
    expect(printed.generation.errorCode).toBe('strategy_generation_stale');
  });
});

describe('runPlanGenerate — typed exit-7 timeout conversion', () => {
  it('converts the raw ladder timeout into the UNSUPPORTED envelope (exit 7, NOT 1) with a partial on stdout', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: accepted('exploration', ['strategy', 'proposals']) }],
      reads: [
        {
          body: {
            generation: { status: 'exploring', errorCode: null, errorMessage: null },
            proposals: [],
            credits: { charged: [], balance: null },
          },
        },
      ],
    });
    // Freeze wall-clock control: let the trigger + first read complete,
    // then report the deadline as passed.
    const realDateNow = Date.now;
    const base = realDateNow();
    let calls = 0;
    Date.now = () => {
      calls += 1;
      return calls > 12 ? base + 120_000 : base;
    };
    const capture: Capture = { stdout: [], stderr: [] };
    try {
      const err = await runPlanGenerate(
        baseOpts({ timeoutSeconds: 60 }),
        makeDeps(backend.fetchImpl, capture) as never,
      ).catch(e => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('UNSUPPORTED');
      expect((err as ApiError).exitCode).toBe(7);
      expect((err as ApiError).nextAction).toContain(
        `testsprite test plan generate --project ${PROJECT_ID}`,
      );
      // §13.3: the envelope carries the stages left, not only the partial.
      expect((err as ApiError).getDetail('stagesRemaining')).toEqual(['strategy', 'proposals']);
      // Partial on stdout so a redirected file is never 0-byte.
      const partial = JSON.parse(capture.stdout.join('\n')) as Record<string, unknown>;
      expect(partial.status).toBe('running');
      expect(partial.generationStatus).toBe('exploring');
      expect(partial.projectId).toBe(PROJECT_ID);
      expect(partial.stagesRemaining).toEqual(['strategy', 'proposals']);
    } finally {
      Date.now = realDateNow;
    }
  });
});

describe('runPlanGenerate — cap-exhaustion stuck fuse partial envelope (F7)', () => {
  it('prints the stdout partial and rethrows the INTERNAL unchanged', async () => {
    // Every trigger is accepted with later stages still "remaining", and
    // every read reports idle+empty — the ladder re-POSTs until the
    // accepted-POST fuse trips. Redirected stdout must carry the partial.
    const backend = makePlanBackend({
      triggers: [{ body: accepted('exploration', ['strategy', 'proposals']) }],
      reads: [
        {
          body: {
            generation: { status: 'idle', errorCode: null, errorMessage: null },
            proposals: [],
            credits: { charged: [], balance: null },
          },
        },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(
      baseOpts({ timeoutSeconds: 600 }),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INTERNAL');
    // Derived, not a literal 3 (#341 review): the fuse is
    // MAX_ACCEPTED_TRIGGER_POSTS = PLAN_GENERATION_STAGES.length, so a fourth
    // stage moves both together instead of drifting this assertion.
    expect((err as ApiError).getDetail('acceptedPosts')).toBe(PLAN_GENERATION_STAGES.length);
    // Partial on stdout so a redirected file is never 0-byte.
    expect(capture.stdout.length).toBeGreaterThan(0);
    const partial = JSON.parse(capture.stdout.join('\n')) as Record<string, unknown>;
    expect(partial.status).toBe('running');
    expect(partial.projectId).toBe(PROJECT_ID);
    // Exploration was accepted (so it counts as started, not left) but was
    // never seen running or finished: not "done", and no Continue: line — an
    // immediate re-run would repeat the same attempts.
    expect(partial.stagesRemaining).toEqual(['strategy', 'proposals']);
    const stderr = capture.stderr.join('\n');
    expect(stderr).not.toContain('done');
    // Every try was accepted here, so tries == accepted == the stage count.
    expect(stderr).toContain(
      `Stage 1/3 exploration is not making progress after ${PLAN_GENERATION_STAGES.length} tries. ` +
        'Wait a few minutes, then run the same command again; it picks up from here.',
    );
    expect(stderr).not.toContain('would not start');
    expect(stderr).not.toContain('Continue:');
  });

  it('attach-only fuse: every try answered "already in progress" — counts the tries, names no stage', async () => {
    // No trigger was ever accepted, so the plan is unknown (stagesRemaining
    // null, no position) and the line must not read "after 0 attempts".
    const backend = makePlanBackend({
      triggers: [errorBody(409, 'CONFLICT', { reason: 'stage_in_flight' })],
      reads: [
        {
          body: {
            generation: { status: 'idle', errorCode: null, errorMessage: null },
            proposals: [],
            credits: { charged: [], balance: null },
          },
        },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(
      baseOpts({ output: 'text', timeoutSeconds: 600 }),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getDetail('acceptedPosts')).toBe(0);
    expect((err as ApiError).getDetail('triggerPosts')).toBe(MAX_TRIGGER_POSTS_TOTAL);
    const stderr = capture.stderr.join('\n');
    expect(stderr).toContain(
      `Generation is not making progress after ${MAX_TRIGGER_POSTS_TOTAL} tries. ` +
        'Wait a few minutes, then run the same command again; it picks up from here.',
    );
    expect(stderr).not.toContain('after 0 ');
    expect(stderr).not.toContain('Continue:');
    const stdout = capture.stdout.join('\n');
    expect(stdout).toContain('status      stalled (appears stuck)');
    expect(stdout).not.toContain('remaining');
  });

  it('mixed fuse: one accepted try then "already in progress" answers — counts every try', async () => {
    const backend = makePlanBackend({
      triggers: [
        { body: accepted('exploration', ['strategy', 'proposals']) },
        errorBody(409, 'CONFLICT', { reason: 'stage_in_flight' }),
      ],
      reads: [
        {
          body: {
            generation: { status: 'idle', errorCode: null, errorMessage: null },
            proposals: [],
            credits: { charged: [], balance: null },
          },
        },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(
      baseOpts({ output: 'text', timeoutSeconds: 600 }),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getDetail('acceptedPosts')).toBe(1);
    expect((err as ApiError).getDetail('triggerPosts')).toBe(MAX_TRIGGER_POSTS_TOTAL);
    const stderr = capture.stderr.join('\n');
    expect(stderr).toContain(
      `Stage 1/3 exploration is not making progress after ${MAX_TRIGGER_POSTS_TOTAL} tries.`,
    );
    const stdout = capture.stdout.join('\n');
    expect(stdout).toContain('status      stalled (appears stuck) during stage 1/3 exploration');
    expect(stdout).toContain('remaining   strategy, proposals');
  });
});

describe('runPlanGenerate — RequestTimeoutError partial envelope', () => {
  it('prints the stdout partial + stderr re-attach hint and rethrows unchanged (exit 7)', async () => {
    let reads = 0;
    const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : (input as { url: string }).url;
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/plans/generate')) {
        return new Response(JSON.stringify(accepted('exploration', ['strategy', 'proposals'])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      reads += 1;
      if (reads <= 2) {
        // Read 1 is the F1 pre-trigger baseline; read 2 is one good tick so
        // lastSeen carries a real generation status.
        return new Response(
          JSON.stringify({
            generation: { status: 'exploring', errorCode: null, errorMessage: null },
            proposals: [],
            credits: { charged: [], balance: null },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Per-request wall-clock timeout mid-poll — http.ts propagates a
      // test-injected RequestTimeoutError unchanged (never re-wrapped).
      throw new RequestTimeoutError(120_000);
    }) as FetchImpl;
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(baseOpts(), makeDeps(fetchImpl, capture) as never).catch(
      e => e,
    );
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as RequestTimeoutError).exitCode).toBe(7);
    // Partial on stdout so a redirected file is never 0-byte.
    const partial = JSON.parse(capture.stdout.join('\n')) as Record<string, unknown>;
    expect(partial).toEqual({
      projectId: PROJECT_ID,
      status: 'running',
      generationStatus: 'exploring',
      proposalsStaged: 0,
      stagesRemaining: ['strategy', 'proposals'],
    });
    const stderr = capture.stderr.join('\n');
    expect(stderr).toContain(
      'Request timed out. Paused during stage 1/3 exploration. 2 stages left.',
    );
    expect(stderr).toContain(`Continue: testsprite test plan generate --project ${PROJECT_ID}`);
  });
});

describe('runPlanGenerate — RATE_LIMITED mid-poll partial envelope', () => {
  it('429 from the plans READ prints the partial and rethrows the original ApiError (exit 11)', async () => {
    let reads = 0;
    const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : (input as { url: string }).url;
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/plans/generate')) {
        return new Response(JSON.stringify(accepted('proposals', [])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      reads += 1;
      if (reads <= 2) {
        // Read 1 = F1 baseline; read 2 = one good tick for lastSeen.
        return new Response(
          JSON.stringify({
            generation: { status: 'proposing', errorCode: null, errorMessage: null },
            proposals: [],
            credits: { charged: [], balance: null },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Every subsequent read 429s; Retry-After: 0 keeps the http.ts
      // internal retry chain instant before the ApiError escapes.
      return new Response(
        JSON.stringify({
          error: {
            code: 'RATE_LIMITED',
            message: 'Error: RATE_LIMITED',
            nextAction: '',
            requestId: 'req_429',
            details: {},
          },
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        },
      );
    }) as FetchImpl;
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(baseOpts(), makeDeps(fetchImpl, capture) as never).catch(
      e => e,
    );
    // The original ApiError is rethrown, never converted (exit stays 11).
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('RATE_LIMITED');
    expect((err as ApiError).exitCode).toBe(11);
    expect((err as ApiError).requestId).toBe('req_429');
    // Partial on stdout so a redirected file is never 0-byte.
    const partial = JSON.parse(capture.stdout.join('\n')) as Record<string, unknown>;
    expect(partial).toEqual({
      projectId: PROJECT_ID,
      status: 'running',
      generationStatus: 'proposing',
      proposalsStaged: 0,
      stagesRemaining: [],
    });
    const stderr = capture.stderr.join('\n');
    expect(stderr).toContain(
      'Rate limited by the server (HTTP 429). Paused during stage 1/1 proposals. Nothing left to start.',
    );
    expect(stderr).toContain(`Continue: testsprite test plan generate --project ${PROJECT_ID}`);
  });
});

describe('runPlanGenerate — SIGINT graceful detach', () => {
  it('prints the partial + honest detach hint and rethrows InterruptError (exit 130)', async () => {
    const shutdown = new ShutdownController();
    let reads = 0;
    const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : (input as { url: string }).url;
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/plans/generate')) {
        return new Response(JSON.stringify(accepted('exploration', ['strategy', 'proposals'])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // The pre-trigger baseline read answers, so the trigger happens and the
      // plan is known; the Ctrl-C lands in the first in-ladder poll.
      reads += 1;
      if (reads === 1) {
        return new Response(
          JSON.stringify({
            generation: { status: 'idle', errorCode: null, errorMessage: null },
            proposals: [],
            credits: { charged: [], balance: null },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // The plans long-poll hangs until the composed signal aborts.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error), {
          once: true,
        });
        queueMicrotask(() => shutdown.interrupt('SIGINT'));
      });
    }) as FetchImpl;
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(
      baseOpts(),
      makeDeps(fetchImpl, capture, { shutdown }) as never,
    ).catch(e => e);
    expect(err).toBeInstanceOf(InterruptError);
    expect((err as InterruptError).exitCode).toBe(130);
    const partial = JSON.parse(capture.stdout.join('\n')) as Record<string, unknown>;
    expect(partial.status).toBe('running');
    const stderr = capture.stderr.join('\n');
    expect(partial).toHaveProperty('stagesRemaining');
    expect(stderr).toContain('Interrupted (SIGINT). Paused');
    expect(stderr).not.toContain('keeps running');
    expect(stderr).toContain('Continue: ');
    expect(stderr).toContain(`testsprite test plan generate --project ${PROJECT_ID}`);
    // The top-level JSON envelope (src/index.ts) is built from this metadata,
    // so it tells the same paused-stage story as the line above instead of
    // the generic "keeps executing… test wait <runId>" run story.
    const detach = (err as InterruptError & { planDetach?: Record<string, unknown> }).planDetach;
    expect(detach).toEqual({
      projectId: PROJECT_ID,
      stagesRemaining: ['strategy', 'proposals'],
      nextAction:
        'Plan generation paused during stage 1/3 exploration. 2 stages left. ' +
        `Continue: testsprite test plan generate --project ${PROJECT_ID}`,
    });
  });
});

// ---------------------------------------------------------------------------
// Generate — stage position lines (one per finished stage, text mode only)
// ---------------------------------------------------------------------------

describe('runPlanGenerate — stage position lines', () => {
  function plansAt(status: 'exploring' | 'strategizing' | 'proposing' | 'idle'): { body: unknown } {
    return {
      body: {
        generation: { status, errorCode: null, errorMessage: null },
        proposals: [],
        credits: { charged: [], balance: null },
      },
    };
  }

  it('prints `stage i/N <name> done` as each stage finishes, numbered from the first trigger', async () => {
    const backend = makePlanBackend({
      triggers: [
        { body: accepted('exploration', ['strategy', 'proposals']) },
        { body: accepted('strategy', ['proposals']) },
        { body: accepted('proposals', []) },
      ],
      // baseline read, then: exploring → idle → strategizing → idle → proposing → staged
      reads: [
        plansAt('idle'),
        plansAt('exploring'),
        plansAt('idle'),
        plansAt('strategizing'),
        plansAt('idle'),
        plansAt('proposing'),
        { body: stagedPlans() },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanGenerate(
      baseOpts({ output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    const stderr = capture.stderr.join('\n');
    expect(stderr).toMatch(/stage 1\/3 exploration done \S+/);
    expect(stderr).toMatch(/stage 2\/3 strategy done \S+/);
    expect(stderr).toMatch(/stage 3\/3 proposals done \S+/);
    expect(backend.calls.filter(c => c.method === 'POST')).toHaveLength(3);
  });

  it('JSON mode prints no stage lines', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: accepted('proposals', []) }],
      reads: [plansAt('idle'), plansAt('proposing'), { body: stagedPlans() }],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanGenerate(
      baseOpts({ output: 'json' }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    expect(capture.stderr.join('\n')).not.toContain('stage 1/1');
  });
});

// ---------------------------------------------------------------------------
// Generate — stage tracker only reports "done" on evidence
// ---------------------------------------------------------------------------

describe('runPlanGenerate — stage tracker evidence gates', () => {
  function plansAt(status: 'exploring' | 'strategizing' | 'proposing' | 'idle'): { body: unknown } {
    return {
      body: {
        generation: { status, errorCode: null, errorMessage: null },
        proposals: [],
        credits: { charged: [], balance: null },
      },
    };
  }

  it('a failed stage is never announced as done', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: accepted('strategy', ['proposals']) }],
      reads: [
        plansAt('idle'),
        {
          body: {
            generation: {
              status: 'failed',
              errorCode: 'strategy_generation_stale',
              errorMessage: 'strategy generation crashed',
            },
            proposals: [],
            credits: { charged: [], balance: null },
          },
        },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(
      baseOpts({ output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(1);
    expect(capture.stderr.join('\n')).not.toContain('done');
  });

  it('idle before the stage was seen running does not count as finished; the real completion prints once', async () => {
    const backend = makePlanBackend({
      triggers: [
        { body: accepted('exploration', ['strategy', 'proposals']) },
        { body: accepted('strategy', ['proposals']) },
        { body: accepted('proposals', []) },
      ],
      // baseline, then the not-yet-started idle read, then the stage runs.
      reads: [
        plansAt('idle'),
        plansAt('idle'),
        plansAt('exploring'),
        plansAt('exploring'),
        plansAt('idle'),
        plansAt('strategizing'),
        plansAt('idle'),
        plansAt('proposing'),
        { body: stagedPlans() },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    // Interleave a marker into the captured stderr before every GET so the
    // ORDER of the stage line relative to the reads is observable: reads 1-2
    // are idle (baseline + not-started), reads 3-4 report exploring, read 5 is
    // the idle that means "finished". The done line must come after read 5,
    // never after read 2 (which is where the previous tracker printed it).
    let gets = 0;
    const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
      if ((init.method ?? 'GET').toUpperCase() === 'GET') capture.stderr.push(`__GET ${++gets}__`);
      return backend.fetchImpl(input, init);
    }) as FetchImpl;
    await runPlanGenerate(baseOpts({ output: 'text' }), makeDeps(fetchImpl, capture) as never);
    const lines = capture.stderr;
    const stderr = lines.join('\n');
    expect(stderr.match(/stage 1\/3 exploration done/g)).toHaveLength(1);
    expect(stderr.match(/stage 2\/3 strategy done/g)).toHaveLength(1);
    expect(stderr.match(/stage 3\/3 proposals done/g)).toHaveLength(1);
    const doneAt = lines.findIndex(l => l.includes('stage 1/3 exploration done'));
    expect(doneAt).toBeGreaterThan(lines.indexOf('__GET 5__'));
    expect(lines.indexOf('__GET 6__') === -1 || doneAt < lines.indexOf('__GET 6__')).toBe(true);
  });

  it('proposals: an idle read with nothing staged yet does not count as done; the staged read does, once', async () => {
    const backend = makePlanBackend({
      triggers: [{ body: accepted('proposals', []) }],
      // baseline, proposing, the idle-but-empty blip the ladder polls through,
      // proposing again, then the real staged batch.
      reads: [
        plansAt('idle'),
        plansAt('proposing'),
        plansAt('idle'),
        plansAt('proposing'),
        { body: stagedPlans() },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    let gets = 0;
    const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
      if ((init.method ?? 'GET').toUpperCase() === 'GET') capture.stderr.push(`__GET ${++gets}__`);
      return backend.fetchImpl(input, init);
    }) as FetchImpl;
    await runPlanGenerate(baseOpts({ output: 'text' }), makeDeps(fetchImpl, capture) as never);
    const lines = capture.stderr;
    expect(lines.join('\n').match(/stage 1\/1 proposals done/g)).toHaveLength(1);
    // Printed only after the fifth read (the staged one), never at the blip (read 3).
    const doneAt = lines.findIndex(l => l.includes('stage 1/1 proposals done'));
    expect(doneAt).toBeGreaterThan(lines.indexOf('__GET 5__'));
  });

  it('a stage seen running that then FAILS is never announced as done (the failed guard, not the active gate)', async () => {
    // Round-3 mutant: with `if (status === 'failed') return` removed, the
    // failed read looks like "active → not active" and prints `done`.
    const backend = makePlanBackend({
      triggers: [{ body: accepted('strategy', ['proposals']) }],
      reads: [
        plansAt('idle'),
        plansAt('strategizing'),
        {
          body: {
            generation: {
              status: 'failed',
              errorCode: 'strategy_generation_stale',
              errorMessage: 'strategy generation crashed',
            },
            proposals: [],
            credits: { charged: [], balance: null },
          },
        },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(
      baseOpts({ output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(1);
    expect(capture.stderr.join('\n')).not.toContain('done');
  });

  it('a stage that finished between two polls is marked done when the NEXT stage is seen running — before that stage finishes', async () => {
    // Round-3 mutant: the later-active `markDone(this.current)` branch. The
    // accepted-trigger loop would eventually catch exploration up, but only
    // AFTER strategy's own done line — so the order is the discriminator.
    const backend = makePlanBackend({
      triggers: [
        { body: accepted('exploration', ['strategy', 'proposals']) },
        { body: accepted('proposals', []) },
      ],
      reads: [
        plansAt('idle'),
        plansAt('strategizing'),
        plansAt('idle'),
        plansAt('proposing'),
        { body: stagedPlans() },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanGenerate(
      baseOpts({ output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    const lines = capture.stderr;
    const stderr = lines.join('\n');
    // Never seen running itself, so no elapsed suffix.
    expect(stderr.match(/^stage 1\/3 exploration done$/gm)).toHaveLength(1);
    expect(stderr.match(/stage 2\/3 strategy done \S+/g)).toHaveLength(1);
    expect(stderr.match(/stage 3\/3 proposals done/g)).toHaveLength(1);
    const explorationAt = lines.findIndex(l => l.includes('stage 1/3 exploration done'));
    const strategyAt = lines.findIndex(l => l.includes('stage 2/3 strategy done'));
    expect(explorationAt).toBeLessThan(strategyAt);
  });

  it('a stage never seen running is marked done by the next ACCEPTED trigger (the predecessor loop)', async () => {
    // Round-3 mutant: the `for (const s of this.planned)` loop in onTrigger.
    // Exploration is accepted, two idle reads follow (finished before our
    // first poll), the ladder re-POSTs and strategy is accepted: that
    // acceptance is the only evidence exploration finished.
    const backend = makePlanBackend({
      triggers: [
        { body: accepted('exploration', ['strategy', 'proposals']) },
        { body: accepted('strategy', ['proposals']) },
        { body: accepted('proposals', []) },
      ],
      reads: [
        plansAt('idle'),
        plansAt('idle'),
        plansAt('idle'),
        plansAt('strategizing'),
        plansAt('idle'),
        plansAt('proposing'),
        { body: stagedPlans() },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    let gets = 0;
    const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
      if ((init.method ?? 'GET').toUpperCase() === 'GET') capture.stderr.push(`__GET ${++gets}__`);
      return backend.fetchImpl(input, init);
    }) as FetchImpl;
    await runPlanGenerate(baseOpts({ output: 'text' }), makeDeps(fetchImpl, capture) as never);
    const lines = capture.stderr;
    expect(lines.join('\n').match(/^stage 1\/3 exploration done$/gm)).toHaveLength(1);
    // Printed at the second accepted trigger: after read 3, before read 4.
    const doneAt = lines.findIndex(l => l.includes('stage 1/3 exploration done'));
    expect(doneAt).toBeGreaterThan(lines.indexOf('__GET 3__'));
    expect(doneAt).toBeLessThan(lines.indexOf('__GET 4__'));
  });

  it('stuck fuse after an earlier stage really ran: that stage is done, the stuck one is named', async () => {
    // Exploration is seen running and then idle; strategy is accepted again
    // and again but never seen running, until the accepted-POST fuse trips.
    const backend = makePlanBackend({
      triggers: [
        { body: accepted('exploration', ['strategy', 'proposals']) },
        { body: accepted('strategy', ['proposals']) },
      ],
      reads: [plansAt('idle'), plansAt('exploring'), plansAt('idle')],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(
      baseOpts({ output: 'text', timeoutSeconds: 600 }),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getDetail('acceptedPosts')).toBe(PLAN_GENERATION_STAGES.length);
    const stderr = capture.stderr.join('\n');
    expect(stderr.match(/stage 1\/3 exploration done/g)).toHaveLength(1);
    expect(stderr).not.toContain('strategy done');
    expect(stderr).toContain(
      `Stage 2/3 strategy is not making progress after ${PLAN_GENERATION_STAGES.length} tries.`,
    );
    expect(stderr).not.toContain('Continue:');
    const stdout = capture.stdout.join('\n');
    expect(stdout).toContain('status      stalled (appears stuck) during stage 2/3 strategy');
    expect(stdout).toContain('remaining   proposals');
  });

  it('interrupted before the stage was seen running: still "during" that stage, only later stages left', async () => {
    const shutdown = new ShutdownController();
    let gets = 0;
    const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : (input as { url: string }).url;
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/plans/generate')) {
        return new Response(JSON.stringify(accepted('exploration', ['strategy', 'proposals'])), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      gets += 1;
      if (gets === 1) {
        // The pre-trigger baseline read answers normally (idle, nothing staged).
        return new Response(JSON.stringify(plansAt('idle').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // The first in-ladder read hangs until Ctrl-C.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error), {
          once: true,
        });
        queueMicrotask(() => shutdown.interrupt('SIGINT'));
      });
    }) as FetchImpl;
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(
      baseOpts({ output: 'text' }),
      makeDeps(fetchImpl, capture, { shutdown }) as never,
    ).catch(e => e);
    expect(err).toBeInstanceOf(InterruptError);
    const stdout = capture.stdout.join('\n');
    const stderr = capture.stderr.join('\n');
    expect(stderr).not.toContain('done');
    // Accepted means started (and charged) even before a poll reports it
    // running, so it is neither "not started" nor left.
    expect(stderr).toContain(
      'Interrupted (SIGINT). Paused during stage 1/3 exploration. 2 stages left.',
    );
    expect(stdout).toContain(
      'status      paused (interrupted (SIGINT)) during stage 1/3 exploration',
    );
    expect(stdout).toContain('remaining   strategy, proposals');
  });
});

// ---------------------------------------------------------------------------
// Generate — §7 error-reason matrix (exact fix commands)
// ---------------------------------------------------------------------------

describe('runPlanGenerate — 412/402/404/429 reason matrix', () => {
  async function triggerError(status: number, code: string, details: Record<string, unknown>) {
    const backend = makePlanBackend({
      triggers: [errorBody(status, code, details)],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = await runPlanGenerate(
      baseOpts(),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e);
    return { err: err as ApiError, capture, backend };
  }

  it('412 v3_required → exit 6, migration note naming the Portal', async () => {
    const { err } = await triggerError(412, 'PRECONDITION_FAILED', { reason: 'v3_required' });
    expect(err.exitCode).toBe(6);
    expect(err.nextAction).toContain('V3 platform');
    expect(err.nextAction).toContain('Portal');
  });

  it('412 environment_url_missing → exit 6, literal `project update --url` fix', async () => {
    const { err } = await triggerError(412, 'PRECONDITION_FAILED', {
      reason: 'environment_url_missing',
    });
    expect(err.exitCode).toBe(6);
    expect(err.nextAction).toContain(`testsprite project update ${PROJECT_ID} --url`);
  });

  it('412 no_plannable_categories → exit 6, strategy-review fix; never says "retry shortly"', async () => {
    const { err } = await triggerError(412, 'PRECONDITION_FAILED', {
      reason: 'no_plannable_categories',
      categoryCount: 2,
    });
    expect(err.exitCode).toBe(6);
    expect(err.nextAction).toContain('Retrying will not change this');
    expect(err.nextAction).toContain(
      `testsprite project docs upload <file> --project ${PROJECT_ID} --role api-doc`,
    );
    expect(err.nextAction).not.toMatch(/retry shortly|still be processing/i);
  });

  it('412 no_plannable_categories with categoryCount 0 → regenerate-the-strategy fix, no docs-upload advice', async () => {
    const { err } = await triggerError(412, 'PRECONDITION_FAILED', {
      reason: 'no_plannable_categories',
      categoryCount: 0,
    });
    expect(err.exitCode).toBe(6);
    expect(err.nextAction).toContain('has no categories');
    expect(err.nextAction).toContain('Regenerate the strategy in the Portal');
    expect(err.nextAction).not.toContain('docs upload');
  });

  it('412 no_plannable_categories with categoryCount 1 → singular wording', async () => {
    const { err } = await triggerError(412, 'PRECONDITION_FAILED', {
      reason: 'no_plannable_categories',
      categoryCount: 1,
    });
    expect(err.nextAction).toContain('its only category has no endpoint');
  });

  it('412 no_processed_inputs → exit 6, docs-upload fix with --role api-doc + still-processing hint', async () => {
    const { err } = await triggerError(412, 'PRECONDITION_FAILED', {
      reason: 'no_processed_inputs',
    });
    expect(err.exitCode).toBe(6);
    expect(err.nextAction).toContain(
      `testsprite project docs upload <file> --project ${PROJECT_ID} --role api-doc`,
    );
    expect(err.nextAction).toContain('still be processing');
  });

  it('backend-supplied nextAction passes through unchanged (fallback only fills empties)', async () => {
    const backend = makePlanBackend({
      triggers: [
        errorBody(412, 'PRECONDITION_FAILED', { reason: 'environment_url_missing' }, 'SERVER SAYS'),
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = (await runPlanGenerate(
      baseOpts(),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e)) as ApiError;
    expect(err.nextAction).toBe('SERVER SAYS');
  });

  it('402 INSUFFICIENT_CREDITS → exit 12', async () => {
    const { err } = await triggerError(402, 'INSUFFICIENT_CREDITS', { required: 3 });
    expect(err.code).toBe('INSUFFICIENT_CREDITS');
    expect(err.exitCode).toBe(12);
  });

  it('404 NOT_FOUND (unknown or cross-workspace project) → exit 4', async () => {
    const { err } = await triggerError(404, 'NOT_FOUND', {});
    expect(err.exitCode).toBe(4);
  });

  it('429 RATE_LIMITED → exit 11 (rethrown unchanged, never reclassified)', async () => {
    const { err, capture } = await triggerError(429, 'RATE_LIMITED', {});
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.exitCode).toBe(11);
    expect(capture.stderr.join('\n')).toContain('Continue: testsprite test plan generate');
  });
});

// ---------------------------------------------------------------------------
// Generate — dry-run
// ---------------------------------------------------------------------------

describe('runPlanGenerate — dry-run', () => {
  it('makes ZERO fetch calls and prints the canned staged-proposals shape', async () => {
    const fetchSpy = vi.fn();
    const capture: Capture = { stdout: [], stderr: [] };
    const result = await runPlanGenerate(baseOpts({ dryRun: true }), {
      fetchImpl: fetchSpy as unknown as FetchImpl,
      stdout: (line: string) => capture.stdout.push(line),
      stderr: (line: string) => capture.stderr.push(line),
    } as never);
    expect(fetchSpy).not.toHaveBeenCalled();
    const printed = JSON.parse(capture.stdout.join('\n')) as {
      projectId: string;
      proposals: Array<{ proposalId: string }>;
    };
    expect(printed.projectId).toBe(PROJECT_ID);
    expect(printed.proposals.map(p => p.proposalId)).toEqual(['prop_1', 'prop_2']);
    expect(printed).toEqual(result);
    expect(capture.stderr.join('\n')).toContain('[dry-run]');
  });
});

// ---------------------------------------------------------------------------
// Accept — §3.3 --only matrix
// ---------------------------------------------------------------------------

describe('runPlanAccept — explicit-list rules', () => {
  it('flag absent → sends the FULL explicit id list (never the omitted form)', async () => {
    const backend = makePlanBackend({
      reads: [{ body: stagedPlans() }],
      accept: { body: { acceptedCount: 3, caseKeys: ['ck1', 'ck2', 'ck3'] } },
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanAccept(baseOpts(), makeDeps(backend.fetchImpl, capture) as never);
    const acceptCall = backend.calls.find(c => c.url.includes('/plans/accept'))!;
    expect(acceptCall.body).toEqual({ only: ['prop_1', 'prop_2', 'prop_3'] });
  });

  it('--only subset → sends exactly that list; output notes the discarded remainder', async () => {
    const backend = makePlanBackend({
      reads: [{ body: stagedPlans() }],
      accept: { body: { acceptedCount: 1, caseKeys: ['ck2'] } },
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const result = await runPlanAccept(
      baseOpts({ only: ['prop_2'], output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    const acceptCall = backend.calls.find(c => c.url.includes('/plans/accept'))!;
    expect(acceptCall.body).toEqual({ only: ['prop_2'] });
    expect(result?.discardedCount).toBe(2);
    const text = capture.stdout.join('\n');
    // The FE/API split line was dropped (F10 — proposal type is
    // project-derived, so a split was degenerate); count only.
    expect(text).toContain('1 proposal accepted — 1 test case created');
    expect(text).not.toContain('frontend,');
    expect(text).toContain('(2 remaining proposals discarded)');
    // prop_2 is a backend proposal → the codegen note must print.
    expect(text).toContain('note: API test code is generated when the tests first run');
  });

  it('frontend-only selection omits the API-codegen note', async () => {
    const backend = makePlanBackend({
      reads: [{ body: stagedPlans() }],
      accept: { body: { acceptedCount: 2, caseKeys: ['ck1', 'ck3'] } },
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanAccept(
      baseOpts({ only: ['prop_1', 'prop_3'], output: 'text' }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    const text = capture.stdout.join('\n');
    expect(text).toContain('2 proposals accepted — 2 test cases created');
    expect(text).not.toContain('frontend,');
    expect(text).not.toContain('API test code is generated');
  });

  it('comma-separated --only tokens are normalized', async () => {
    const backend = makePlanBackend({
      reads: [{ body: stagedPlans() }],
      accept: { body: { acceptedCount: 2, caseKeys: ['ck1', 'ck2'] } },
    });
    const capture: Capture = { stdout: [], stderr: [] };
    await runPlanAccept(
      baseOpts({ only: ['prop_1,prop_2'] }),
      makeDeps(backend.fetchImpl, capture) as never,
    );
    const acceptCall = backend.calls.find(c => c.url.includes('/plans/accept'))!;
    expect(acceptCall.body).toEqual({ only: ['prop_1', 'prop_2'] });
  });

  it('zero matching ids → exit 5, unknown ids NAMED, accept request NEVER sent', async () => {
    const backend = makePlanBackend({
      reads: [{ body: stagedPlans() }],
      accept: { body: { acceptedCount: 0, caseKeys: [] } },
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = (await runPlanAccept(
      baseOpts({ only: ['nope_1', 'nope_2'] }),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.exitCode).toBe(5);
    expect(err.nextAction).toContain('nope_1, nope_2');
    expect(err.nextAction).toContain('was not sent');
    expect(backend.calls.some(c => c.url.includes('/plans/accept'))).toBe(false);
  });

  it('partially-unknown ids are also a validation error (no silent subset)', async () => {
    const backend = makePlanBackend({
      reads: [{ body: stagedPlans() }],
      accept: { body: { acceptedCount: 1, caseKeys: ['ck1'] } },
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = (await runPlanAccept(
      baseOpts({ only: ['prop_1', 'typo_9'] }),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e)) as ApiError;
    expect(err.exitCode).toBe(5);
    // The unknown segment names ONLY the misses (the staged-ids list that
    // follows is a help hint, not part of the unknown set).
    expect(err.nextAction).toContain('matches id(s): typo_9.');
    expect(backend.calls.some(c => c.url.includes('/plans/accept'))).toBe(false);
  });

  it('--only with only empty/comma tokens → exit 5 before any request', async () => {
    const backend = makePlanBackend({});
    const capture: Capture = { stdout: [], stderr: [] };
    const err = (await runPlanAccept(
      baseOpts({ only: [','] }),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e)) as ApiError;
    expect(err.exitCode).toBe(5);
    expect(backend.calls).toHaveLength(0);
  });

  it('nothing staged → exit 6 with a pointer at `test plan generate`, request never sent', async () => {
    const backend = makePlanBackend({
      reads: [{ body: stagedPlans([]) }],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = (await runPlanAccept(
      baseOpts(),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e)) as ApiError;
    expect(err.code).toBe('PRECONDITION_FAILED');
    expect(err.exitCode).toBe(6);
    expect(err.getDetail('reason')).toBe('nothing_staged');
    expect(err.nextAction).toContain(`testsprite test plan generate --project ${PROJECT_ID}`);
    expect(backend.calls.some(c => c.url.includes('/plans/accept'))).toBe(false);
  });

  it('server 412 nothing_staged on the POST (read/accept race) → exit 6 with the fix filled', async () => {
    const backend = makePlanBackend({
      reads: [{ body: stagedPlans() }],
      accept: errorBody(412, 'PRECONDITION_FAILED', { reason: 'nothing_staged' }),
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const err = (await runPlanAccept(
      baseOpts(),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e)) as ApiError;
    expect(err.exitCode).toBe(6);
    expect(err.nextAction).toContain('test plan generate');
  });

  it('JSON parity: server truth + discard count (no derived split — F10)', async () => {
    const backend = makePlanBackend({
      reads: [{ body: stagedPlans() }],
      accept: { body: { acceptedCount: 3, caseKeys: ['ck1', 'ck2', 'ck3'] } },
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const result = await runPlanAccept(baseOpts(), makeDeps(backend.fetchImpl, capture) as never);
    const printed = JSON.parse(capture.stdout.join('\n')) as Record<string, unknown>;
    expect(printed).toEqual({
      projectId: PROJECT_ID,
      acceptedCount: 3,
      caseKeys: ['ck1', 'ck2', 'ck3'],
      discardedCount: 0,
    });
    expect(printed).toEqual(result);
  });

  it('missing --project exits 5 before any request', async () => {
    const backend = makePlanBackend({});
    const capture: Capture = { stdout: [], stderr: [] };
    const err = (await runPlanAccept(
      baseOpts({ projectId: undefined }),
      makeDeps(backend.fetchImpl, capture) as never,
    ).catch(e => e)) as ApiError;
    expect(err.exitCode).toBe(5);
    expect(err.nextAction).toContain('TESTSPRITE_PROJECT_ID');
    expect(backend.calls).toHaveLength(0);
  });

  it('picks up TESTSPRITE_PROJECT_ID when --project is absent (F5)', async () => {
    const backend = makePlanBackend({
      reads: [{ body: stagedPlans() }],
      accept: { body: { acceptedCount: 3, caseKeys: ['ck1', 'ck2', 'ck3'] } },
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const result = await runPlanAccept(
      baseOpts({ projectId: undefined }),
      makeDeps(backend.fetchImpl, capture, {
        env: { TESTSPRITE_PROJECT_ID: PROJECT_ID },
      }) as never,
    );
    expect(result?.projectId).toBe(PROJECT_ID);
    expect(result?.acceptedCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Accept — dry-run
// ---------------------------------------------------------------------------

describe('runPlanAccept — dry-run', () => {
  it('zero fetch calls; --only subset echoes input-derived acceptedCount from the sample', async () => {
    const fetchSpy = vi.fn();
    const capture: Capture = { stdout: [], stderr: [] };
    const result = await runPlanAccept(baseOpts({ dryRun: true, only: ['prop_2'] }), {
      fetchImpl: fetchSpy as unknown as FetchImpl,
      stdout: (line: string) => capture.stdout.push(line),
      stderr: (line: string) => capture.stderr.push(line),
    } as never);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result?.acceptedCount).toBe(1);
    expect(result?.discardedCount).toBe(1);
  });

  it('dry-run still enforces the unknown-id validation against the canned staged ids', async () => {
    const fetchSpy = vi.fn();
    const capture: Capture = { stdout: [], stderr: [] };
    const err = (await runPlanAccept(baseOpts({ dryRun: true, only: ['prop_404'] }), {
      fetchImpl: fetchSpy as unknown as FetchImpl,
      stdout: (line: string) => capture.stdout.push(line),
      stderr: (line: string) => capture.stderr.push(line),
    } as never).catch(e => e)) as ApiError;
    expect(err.exitCode).toBe(5);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Generate — command wiring defaults
// ---------------------------------------------------------------------------

describe('test plan generate — --timeout default wiring', () => {
  it('passes the 1800s default through to the ladder when --timeout is absent', async () => {
    // Pin PLAN_GENERATE_DEFAULT_TIMEOUT_SECONDS end-to-end: drive the real
    // command action (no --timeout flag), force the deadline past, and read
    // the default back out of the typed exit-7 envelope the wiring produced.
    const backend = makePlanBackend({
      triggers: [{ body: accepted('exploration', ['strategy', 'proposals']) }],
      reads: [
        {
          body: {
            generation: { status: 'exploring', errorCode: null, errorMessage: null },
            proposals: [],
            credits: { charged: [], balance: null },
          },
        },
      ],
    });
    const capture: Capture = { stdout: [], stderr: [] };
    const test = createTestCommand(makeDeps(backend.fetchImpl, capture) as never);
    const realDateNow = Date.now;
    const base = realDateNow();
    let calls = 0;
    Date.now = () => {
      calls += 1;
      // Let the trigger + first read complete, then jump past the default
      // 1800s budget (anything short of it would keep polling forever).
      return calls > 12 ? base + 1_900_000 : base;
    };
    try {
      const err = await test
        .parseAsync(['plan', 'generate', '--project', PROJECT_ID], { from: 'user' })
        .catch(e => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('UNSUPPORTED');
      expect((err as ApiError).exitCode).toBe(7);
      expect((err as ApiError).getDetail('timeoutSeconds')).toBe(1800);
      expect((err as ApiError).message).toContain(
        `Timed out after 1800s waiting for plan generation on project ${PROJECT_ID}`,
      );
    } finally {
      Date.now = realDateNow;
    }
  });
});
