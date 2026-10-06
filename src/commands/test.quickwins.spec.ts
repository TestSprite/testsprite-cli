/**
 * Unit tests for dogfood L1796 quick-wins:
 *   Piece 3: `test create-batch --plan-from-dir <dir>`
 *   Piece 4: `test delete-batch` + `test delete-batch --all`
 *
 * All HTTP is mocked; no real credentials required.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InterruptError } from '../lib/errors.js';
import { runCreateBatch } from './test.js';
import { runDeleteBatch } from './test.js';
import type { CliBulkDeleteSummary } from './test.js';

// ---------------------------------------------------------------------------
// Helpers shared across pieces
// ---------------------------------------------------------------------------

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function makeFetch(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
): typeof globalThis.fetch {
  return (async (input: FetchInput, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

function makeCreds(
  apiKey = 'sk-user-test',
  apiUrl = 'http://localhost:13503',
): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-qw-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath };
}

/** Minimal valid plan spec (FE). */
const PLAN_SPEC = {
  projectId: 'project_abc',
  type: 'frontend',
  name: 'Plan test',
  planSteps: [
    { type: 'action', description: 'Click button' },
    { type: 'assertion', description: 'Check result' },
  ],
};

/** Canned batch-create server response. */
function batchCreateResp(count: number) {
  return {
    results: Array.from({ length: count }, (_, i) => ({
      specIndex: i,
      testId: `test_batch_${i}`,
      status: 'created',
    })),
    summary: { total: count, created: count, failed: 0 },
  };
}

/** Canned delete server response. */
function deleteResp(testId: string) {
  return {
    testId,
    deletedAt: '2026-06-03T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Piece 3: `test create-batch --plan-from-dir`
// ---------------------------------------------------------------------------

describe('runCreateBatch --plan-from-dir (dogfood L1796)', () => {
  it('reads *.json files from the dir, assembles specs, and posts to /tests/batch', async () => {
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-'));

    // Write 3 plan files.
    for (let i = 0; i < 3; i++) {
      writeFileSync(
        join(dir, `plan_${String(i).padStart(2, '0')}.json`),
        JSON.stringify({ ...PLAN_SPEC, name: `Plan ${i}` }),
        'utf8',
      );
    }

    let capturedBody: unknown;
    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/batch') && init.method === 'POST') {
        capturedBody = JSON.parse(init.body as string);
        return { body: batchCreateResp(3) };
      }
      return { body: {} };
    });

    const stderr: string[] = [];
    const result = await runCreateBatch(
      {
        plans: '',
        planFromDir: dir,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, fetchImpl, stderr: (l: string) => stderr.push(l) },
    );

    expect(result.summary.total).toBe(3);
    expect(result.summary.created).toBe(3);

    // The captured request body should have 3 specs in name-sorted order.
    const body = capturedBody as { tests: Array<{ name: string }> };
    expect(body.tests).toHaveLength(3);
    expect(body.tests[0]!.name).toBe('Plan 0');
    expect(body.tests[1]!.name).toBe('Plan 1');
    expect(body.tests[2]!.name).toBe('Plan 2');

    // Stderr should mention reading N plan files.
    expect(stderr.some(l => l.includes('Reading 3 plan files'))).toBe(true);
  });

  it('rejects when dir does not exist', async () => {
    const creds = makeCreds();
    const noexistBase = mkdtempSync(join(tmpdir(), 'cli-pfd-noexist-'));
    await expect(
      runCreateBatch(
        {
          plans: '',
          planFromDir: join(noexistBase, 'definitely-does-not-exist-qw-test'),
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    )
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      .finally(() => rmSync(noexistBase, { recursive: true, force: true }));
  });

  it('rejects when dir has no *.json files', async () => {
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-empty-'));
    // Write a non-json file.
    writeFileSync(join(dir, 'plan.txt'), 'not json');
    await expect(
      runCreateBatch(
        {
          plans: '',
          planFromDir: dir,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects when a file contains invalid JSON', async () => {
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-bad-'));
    writeFileSync(join(dir, 'plan_00.json'), '{ not json }');
    await expect(
      runCreateBatch(
        {
          plans: '',
          planFromDir: dir,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects when a file fails schema validation (missing planSteps)', async () => {
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-bad-schema-'));
    writeFileSync(
      join(dir, 'plan_00.json'),
      JSON.stringify({ projectId: 'p1', type: 'frontend', name: 'No steps' }),
    );
    await expect(
      runCreateBatch(
        {
          plans: '',
          planFromDir: dir,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects when both --plans and --plan-from-dir are supplied', async () => {
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-mutual-'));
    const plansFile = join(dir, 'some.jsonl');
    await expect(
      runCreateBatch(
        {
          plans: plansFile,
          planFromDir: dir,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    )
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      .finally(() => rmSync(dir, { recursive: true, force: true }));
  });

  it('create-batch command exposes --plan-from-dir flag', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    const batch = test.commands.find(c => c.name() === 'create-batch')!;
    const flagNames = batch.options.map(o => o.long);
    expect(flagNames).toContain('--plan-from-dir');
  });

  it('Fix 2 — dir with suite-index.json + N valid plans ingests exactly N plans and emits a warn', async () => {
    // suite-index.json is not a valid plan (missing planSteps, wrong shape).
    // The old behavior aborted the whole batch; now it skips with a [warn].
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-fix2-'));

    // 2 valid plan files
    for (let i = 0; i < 2; i++) {
      writeFileSync(
        join(dir, `plan_0${i}.json`),
        JSON.stringify({ ...PLAN_SPEC, name: `Fix2 Plan ${i}` }),
        'utf8',
      );
    }
    // suite-index.json — the problematic non-plan JSON file
    writeFileSync(
      join(dir, 'suite-index.json'),
      JSON.stringify({ suiteId: 'wc-v1', tests: [] }),
      'utf8',
    );

    let capturedBody: unknown;
    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/batch') && init.method === 'POST') {
        capturedBody = JSON.parse(init.body as string);
        return { body: batchCreateResp(2) };
      }
      return { body: {} };
    });

    const stderr: string[] = [];
    const result = await runCreateBatch(
      {
        plans: '',
        planFromDir: dir,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, fetchImpl, stderr: (l: string) => stderr.push(l) },
    );

    // Only 2 valid plans should have been submitted.
    expect(result.summary.total).toBe(2);
    const body = capturedBody as { tests: unknown[] };
    expect(body.tests).toHaveLength(2);

    // A [warn] advisory should have been emitted for the skipped file.
    const warnLine = stderr.find(l => l.includes('[warn]') && l.includes('suite-index.json'));
    expect(warnLine).toBeDefined();
    // No fatal error — function returned normally.
  });

  it('Fix 2 — dir with ONLY invalid files still throws a fatal VALIDATION_ERROR', async () => {
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-fix2-all-bad-'));
    writeFileSync(
      join(dir, 'suite-index.json'),
      JSON.stringify({ suiteId: 'x', tests: [] }),
      'utf8',
    );
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ version: '1.0' }), 'utf8');

    await expect(
      runCreateBatch(
        {
          plans: '',
          planFromDir: dir,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // ---------------------------------------------------------------------------
  // Finding 2 — batch limit enforced on VALID specs AFTER skipping invalid files
  // ---------------------------------------------------------------------------

  it('[finding-2] 50 valid plans + 1 invalid (suite-index.json) succeeds (not over-limit)', async () => {
    // Before the fix, entries.length > MAX_BATCH_SPECS fired BEFORE the skip
    // loop, so 50 valid + 1 invalid = 51 entries was rejected even though
    // only 50 valid specs would be submitted. After the fix the check is on
    // specs.length (valid only) after filtering.
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-f2-51-'));

    // 50 valid plan files
    for (let i = 0; i < 50; i++) {
      writeFileSync(
        join(dir, `plan_${String(i).padStart(2, '0')}.json`),
        JSON.stringify({ ...PLAN_SPEC, name: `Batch50 Plan ${i}` }),
        'utf8',
      );
    }
    // 1 invalid (non-plan) file that should be skipped
    writeFileSync(
      join(dir, 'suite-index.json'),
      JSON.stringify({ suiteId: 'wc-v1', tests: [] }),
      'utf8',
    );

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/batch') && init.method === 'POST') {
        return { body: batchCreateResp(50) };
      }
      return { body: {} };
    });

    const stderr: string[] = [];
    const result = await runCreateBatch(
      {
        plans: '',
        planFromDir: dir,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, fetchImpl, stderr: (l: string) => stderr.push(l) },
    );

    // Should have submitted exactly 50 valid specs
    expect(result.summary.total).toBe(50);
    // The suite-index.json should have been skipped with a [warn]
    expect(stderr.some(l => l.includes('[warn]') && l.includes('suite-index.json'))).toBe(true);
  });

  it('[finding-2] 51 valid plans (no invalid files) still triggers the over-limit error', async () => {
    // 51 genuine plan files should still be rejected — the limit on valid specs.
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-f2-overlimit-'));

    for (let i = 0; i < 51; i++) {
      writeFileSync(
        join(dir, `plan_${String(i).padStart(2, '0')}.json`),
        JSON.stringify({ ...PLAN_SPEC, name: `OverLimit Plan ${i}` }),
        'utf8',
      );
    }

    await expect(
      runCreateBatch(
        {
          plans: '',
          planFromDir: dir,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // ---------------------------------------------------------------------------
  // Finding A (codex round-2) — malformed/truncated JSON must remain FATAL;
  // only skip valid-JSON files that clearly lack plan identity.
  // ---------------------------------------------------------------------------

  it('[finding-A] truncated/invalid JSON in plan file is FATAL (not silently skipped)', async () => {
    // A truncated file (partial write, disk error) looks like an intended plan
    // that got corrupted. Silently skipping it would let automation create an
    // incomplete suite. Must abort the whole batch with VALIDATION_ERROR.
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-fa-truncated-'));

    // Write one good plan and one truncated "plan" file
    writeFileSync(
      join(dir, 'plan_00.json'),
      JSON.stringify({ ...PLAN_SPEC, name: 'Good Plan' }),
      'utf8',
    );
    writeFileSync(join(dir, 'plan_01.json'), '{"projectId": "p1", "planSteps": [', 'utf8');

    await expect(
      runCreateBatch(
        {
          plans: '',
          planFromDir: dir,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('[finding-A] a file with projectId but botched planSteps is FATAL (not skipped)', async () => {
    // A file that has projectId (looks like a plan) but invalid planSteps is a
    // botched/partial plan — must be FATAL so the user knows to fix it.
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-fa-botched-'));

    writeFileSync(
      join(dir, 'plan_00.json'),
      JSON.stringify({
        projectId: 'p1',
        type: 'frontend',
        name: 'Botched',
        planSteps: 'not-array',
      }),
      'utf8',
    );

    await expect(
      runCreateBatch(
        {
          plans: '',
          planFromDir: dir,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('[finding-A] clearly-non-plan JSON (no projectId/planSteps) is skipped not fatal', async () => {
    // A file with no plan-identity fields (e.g. a config/lock file accidentally
    // placed in the plan directory) should be skipped with a [warn], not abort.
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-fa-nonplan-'));

    // Non-plan file: no projectId, no planSteps
    writeFileSync(
      join(dir, 'suite-index.json'),
      JSON.stringify({ suiteId: 'v1', generatedAt: '2026-01-01', tests: [] }),
      'utf8',
    );
    // One valid plan file to ensure the batch doesn't fail on "no valid plans"
    writeFileSync(
      join(dir, 'plan_00.json'),
      JSON.stringify({ ...PLAN_SPEC, name: 'Real Plan' }),
      'utf8',
    );

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/batch') && init.method === 'POST') {
        return { body: batchCreateResp(1) };
      }
      return { body: {} };
    });
    const stderr: string[] = [];
    const result = await runCreateBatch(
      {
        plans: '',
        planFromDir: dir,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, fetchImpl, stderr: (l: string) => stderr.push(l) },
    );

    // Only 1 valid plan submitted
    expect(result.summary.total).toBe(1);
    // A [warn] advisory for the skipped non-plan file
    expect(stderr.some(l => l.includes('[warn]') && l.includes('suite-index.json'))).toBe(true);
  });

  it('[finding-A] a file with only planSteps (no projectId) is still skipped (clearly non-plan)', async () => {
    // A file with planSteps but no projectId could be a step-template file,
    // not a full plan spec. Heuristic: must have EITHER projectId OR planSteps
    // to be treated as an intended plan. Since this has planSteps but no projectId,
    // looksLikePlan is still true — it will attempt assertPlanShape and fail FATAL.
    // Document that intent here so we don't accidentally weaken the gate.
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-pfd-fa-steps-only-'));

    writeFileSync(
      join(dir, 'steps-template.json'),
      JSON.stringify({
        planSteps: [{ type: 'action', description: 'Click' }],
        // Missing projectId, type, name
      }),
      'utf8',
    );

    await expect(
      runCreateBatch(
        {
          plans: '',
          planFromDir: dir,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

// ---------------------------------------------------------------------------
// Piece 4: `test delete-batch` and `test delete-batch --all`
// ---------------------------------------------------------------------------

describe('runDeleteBatch (dogfood L1796)', () => {
  it('stops deleting remaining tests after an interrupted request', async () => {
    const creds = makeCreds();
    const interruption = new InterruptError('SIGINT');
    const deleted: string[] = [];
    const fetchImpl = makeFetch((url, init) => {
      if (init.method === 'DELETE') {
        deleted.push(url);
        if (deleted.length === 1) throw interruption;
        return { body: deleteResp('test_b') };
      }
      return { body: {} };
    });

    await expect(
      runDeleteBatch(
        {
          testIds: ['test_a', 'test_b'],
          all: false,
          confirm: true,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, fetchImpl, stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toBe(interruption);
    expect(deleted).toHaveLength(1);
  });

  it('exit 5 when --confirm is not set', async () => {
    const creds = makeCreds();
    await expect(
      runDeleteBatch(
        {
          testIds: ['test_a', 'test_b'],
          all: false,
          confirm: false,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('exit 5 when no testIds and --all is false', async () => {
    const creds = makeCreds();
    await expect(
      runDeleteBatch(
        {
          testIds: [],
          all: false,
          confirm: true,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('exit 5 when --all is set but --project is missing', async () => {
    const creds = makeCreds();
    await expect(
      runDeleteBatch(
        {
          testIds: [],
          all: true,
          confirm: true,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('deletes explicit testIds sequentially, returns summary', async () => {
    const creds = makeCreds();
    const deleted: string[] = [];
    const fetchImpl = makeFetch((url, init) => {
      if (init.method === 'DELETE' && url.includes('/tests/')) {
        const testId = url.split('/tests/')[1]!.split('?')[0]!;
        deleted.push(testId);
        return { body: deleteResp(decodeURIComponent(testId)) };
      }
      return { body: {} };
    });

    const stderr: string[] = [];
    const result = await runDeleteBatch(
      {
        testIds: ['test_a', 'test_b'],
        all: false,
        confirm: true,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, fetchImpl, stderr: (l: string) => stderr.push(l) },
    );

    expect(result.summary).toEqual({ total: 2, deleted: 2, skipped: 0, failed: 0 });
    expect(deleted.sort()).toEqual(['test_a', 'test_b'].sort());
    // stderr summary
    expect(stderr.some(l => l.includes('Deleted 2'))).toBe(true);
  });

  it('counts 404 as skipped, not error, and still returns 0 exit', async () => {
    const creds = makeCreds();
    const fetchImpl = makeFetch((url, init) => {
      if (init.method === 'DELETE') {
        if (url.includes('test_gone')) {
          return {
            status: 404,
            body: {
              error: {
                code: 'NOT_FOUND',
                message: 'not found',
                nextAction: '',
                requestId: 'r1',
                details: {},
              },
            },
          };
        }
        const testId = url.split('/tests/')[1]!.split('?')[0]!;
        return { body: deleteResp(testId) };
      }
      return { body: {} };
    });

    const result = await runDeleteBatch(
      {
        testIds: ['test_ok', 'test_gone'],
        all: false,
        confirm: true,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, fetchImpl, stderr: () => {} },
    );

    expect(result.summary).toEqual({ total: 2, deleted: 1, skipped: 1, failed: 0 });
    const skipped = result.results.find(r => r.testId === 'test_gone');
    expect(skipped?.status).toBe('skipped');
  });

  it('--dry-run skips all HTTP calls and returns full synthetic summary', async () => {
    const creds = makeCreds();
    const callCount = { n: 0 };
    const fetchImpl = makeFetch(() => {
      callCount.n++;
      return { body: {} };
    });

    const result = await runDeleteBatch(
      {
        testIds: ['test_a', 'test_b', 'test_c'],
        all: false,
        confirm: false, // --dry-run skips confirm check
        output: 'json',
        profile: 'default',
        dryRun: true,
        debug: false,
        verbose: false,
      },
      { ...creds, fetchImpl, stderr: () => {} },
    );

    // No HTTP calls should have been made.
    expect(callCount.n).toBe(0);
    expect(result.summary).toEqual({ total: 3, deleted: 3, skipped: 0, failed: 0 });
  });

  it('--all resolves project tests and deletes all of them', async () => {
    const creds = makeCreds();
    const deletedIds: string[] = [];

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests') && (!init.method || init.method === 'GET')) {
        return {
          body: {
            items: [
              { id: 'test_a', status: 'passed' },
              { id: 'test_b', status: 'failed' },
            ],
            nextToken: null,
          },
        };
      }
      if (init.method === 'DELETE') {
        const testId = url.split('/tests/')[1]!.split('?')[0]!;
        deletedIds.push(decodeURIComponent(testId));
        return { body: deleteResp(decodeURIComponent(testId)) };
      }
      return { body: {} };
    });

    const result: CliBulkDeleteSummary = await runDeleteBatch(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        confirm: true,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, fetchImpl, stderr: () => {} },
    );

    expect(deletedIds.sort()).toEqual(['test_a', 'test_b'].sort());
    expect(result.summary).toEqual({ total: 2, deleted: 2, skipped: 0, failed: 0 });
  });

  it('--all with --status filter only deletes matching tests', async () => {
    const creds = makeCreds();
    const deletedIds: string[] = [];

    const allTests = [
      { id: 'test_passed', status: 'passed' },
      { id: 'test_failed', status: 'failed' },
      { id: 'test_running', status: 'running' },
    ];

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests') && (!init.method || init.method === 'GET')) {
        return { body: { items: allTests, nextToken: null } };
      }
      if (init.method === 'DELETE') {
        const testId = url.split('/tests/')[1]!.split('?')[0]!;
        deletedIds.push(decodeURIComponent(testId));
        return { body: deleteResp(decodeURIComponent(testId)) };
      }
      return { body: {} };
    });

    await runDeleteBatch(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        statusFilter: 'failed',
        confirm: true,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, fetchImpl, stderr: () => {} },
    );

    // Only the failed test should be deleted.
    expect(deletedIds).toEqual(['test_failed']);
  });

  it('exit 5 when --status contains an invalid token', async () => {
    const creds = makeCreds();
    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests') && (!init.method || init.method === 'GET')) {
        return { body: { items: [], nextToken: null } };
      }
      return { body: {} };
    });
    await expect(
      runDeleteBatch(
        {
          testIds: [],
          all: true,
          projectId: 'project_abc',
          statusFilter: 'notastatus',
          confirm: true,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // ---- correctness-fix tests (code-review 2026-06-04) ----------------------

  it('exit 5 when explicit IDs and --all are both supplied (data-loss guard)', async () => {
    const creds = makeCreds();
    // Passing both explicit test IDs and --all is ambiguous; the CLI must
    // reject early with VALIDATION_ERROR rather than silently discarding the
    // explicit IDs and wiping the whole project.
    await expect(
      runDeleteBatch(
        {
          testIds: ['test_a', 'test_b'],
          all: true,
          projectId: 'project_abc',
          confirm: true,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      // localValidationError always sets message: 'Invalid request.'; the
      // readable explanation lives in nextAction.
      nextAction: expect.stringContaining('--all'),
    });
  });

  it('exit 5 when --status is set without --all (would be silently ignored)', async () => {
    const creds = makeCreds();
    // --status only has meaning in the --all path (it filters the project-wide
    // listing). Without --all the flag would be silently discarded; reject instead.
    await expect(
      runDeleteBatch(
        {
          testIds: ['test_a'],
          all: false,
          statusFilter: 'failed',
          confirm: true,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        creds,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      // localValidationError always sets message: 'Invalid request.'; the
      // readable explanation lives in nextAction.
      nextAction: expect.stringContaining('--status'),
    });
  });

  it('--dry-run --all emits a warning that the preview uses sample data', async () => {
    const creds = makeCreds();
    const stderrLines: string[] = [];

    // The dry-run client uses canned responses regardless of the real project,
    // so the "would delete" list is misleading. A clear warning must be emitted.
    await runDeleteBatch(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        confirm: false, // --dry-run skips the confirm gate
        output: 'json',
        profile: 'default',
        dryRun: true,
        debug: false,
        verbose: false,
      },
      { ...creds, stderr: (l: string) => stderrLines.push(l) },
    );

    const warnLine = stderrLines.find(l => l.includes('sample data'));
    expect(warnLine).toBeDefined();
    expect(warnLine).toMatch(/does NOT reflect/);
  });

  it('delete-batch command is registered in the test command', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    const names = test.commands.map(c => c.name());
    expect(names).toContain('delete-batch');
  });

  it('delete-batch command exposes expected flags', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    const batch = test.commands.find(c => c.name() === 'delete-batch')!;
    const flagNames = batch.options.map(o => o.long);
    expect(flagNames).toContain('--confirm');
    expect(flagNames).toContain('--all');
    expect(flagNames).toContain('--project');
    expect(flagNames).toContain('--status');
  });
});

// ---------------------------------------------------------------------------
// create-batch --run --wait interrupt partial carries the dispatched runIds,
// not empty placeholders
// ---------------------------------------------------------------------------

describe('create-batch --run --wait — InterruptError partial names dispatched runIds', () => {
  it('interrupt mid-poll → partial rows carry the runIds recorded at trigger time', async () => {
    const creds = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-create-batch-run-'));
    for (let i = 0; i < 2; i++) {
      writeFileSync(
        join(dir, `plan_${i}.json`),
        JSON.stringify({ ...PLAN_SPEC, name: `Plan ${i}` }),
        'utf8',
      );
    }

    const { ShutdownController } = await import('../lib/interrupt.js');
    const { InterruptError } = await import('../lib/errors.js');
    const shutdown = new ShutdownController();

    // batch create resolves; each trigger POST resolves with a per-test runId;
    // every run poll hangs until the composed signal aborts.
    const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      if (url.includes('/tests/batch') && init.method === 'POST') {
        return new Response(JSON.stringify(batchCreateResp(2)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (init.method === 'POST' && /\/tests\/[^/]+\/runs$/.test(url)) {
        const testId = /\/tests\/([^/]+)\/runs$/.exec(url)![1]!;
        return new Response(
          JSON.stringify({
            runId: `run_${testId}`,
            status: 'queued',
            enqueuedAt: '2026-07-09T10:00:00.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://example.com',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (init.method === 'GET' && /\/tests\/[^/]+$/.test(url))
        return new Response(JSON.stringify({ type: 'frontend', projectId: 'project_1' }));
      if (init.method === 'GET' && url.endsWith('/projects/project_abc/env'))
        return new Response(JSON.stringify({ environments: [] }));
      // GET /runs/{id} long-poll: hang until aborted.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        const rejectWithReason = (): void => {
          const reason: unknown = signal?.reason;
          reject(reason instanceof Error ? reason : new Error('aborted'));
        };
        if (signal?.aborted) {
          rejectWithReason();
          return;
        }
        signal?.addEventListener('abort', rejectWithReason, { once: true });
      });
    }) as typeof globalThis.fetch;

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const pending = runCreateBatch(
      {
        plans: '',
        planFromDir: dir,
        run: true,
        wait: true,
        timeoutSeconds: 600,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        fetchImpl,
        stdout: (l: string) => stdoutLines.push(l),
        stderr: (l: string) => stderrLines.push(l),
        sleep: () => Promise.resolve(),
        shutdown,
      },
    );
    setTimeout(() => shutdown.interrupt('SIGINT'), 25);

    const err = await pending.catch(e => e);
    expect(err).toBeInstanceOf(InterruptError);

    // The partial must name the real runIds recorded at trigger time —
    // members mid-poll have no settled result, but their runId is known.
    const stdoutJson = JSON.parse(stdoutLines.join('\n')) as {
      results: Array<{ testId: string; runId: string; status: string }>;
    };
    const byTestId = new Map(stdoutJson.results.map(r => [r.testId, r]));
    expect(byTestId.get('test_batch_0')?.runId).toBe('run_test_batch_0');
    expect(byTestId.get('test_batch_0')?.status).toBe('running');
    expect(byTestId.get('test_batch_1')?.runId).toBe('run_test_batch_1');

    const stderrBlock = stderrLines.join('\n');
    expect(stderrBlock).toContain('billing');
    expect(stderrBlock).toContain('run_test_batch_0');
    expect(stderrBlock).toContain('run_test_batch_1');
  });
});
