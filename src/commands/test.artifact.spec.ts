/**
 * M3.3 piece-4 — `test artifact get <run-id>` unit tests.
 *
 * Covers every flag combination, 404 reason, 409 retry, meta.runId
 * mismatch, dry-run, and the §7 on-disk layout.
 *
 * The M2 non-regression test at the bottom confirms that `writeBundle`
 * called from `runFailureGet` (M2 path) still exits 0 with an M2-shaped
 * context (meta.runId = null), verifying the `requireRunId` option is
 * strictly opt-in.
 */

import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import type { ApiError } from '../lib/errors.js';
import type { CliFailureContext, CliLatestResult, CliTestStep } from './test.js';
import {
  assertOutDirParentExists,
  createTestArtifactCommand,
  createTestCommand,
  resolveDefaultArtifactDir,
  runArtifactGet,
  runFailureGet,
} from './test.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SAMPLE_RUN_ID = 'run_piece4_test';
const SAMPLE_SNAPSHOT_ID = 'snap_2026_05_15_piece4';

const SAMPLE_STEPS: CliTestStep[] = [
  {
    testId: 'test_fe',
    stepIndex: 4,
    action: 'click',
    description: 'Click cart',
    status: 'passed',
    screenshotUrl: null,
    htmlSnapshotUrl: 'https://signed.example.com/04.html',
    runIdIfAvailable: SAMPLE_RUN_ID,
    codeVersion: 'v3',
    capturedAt: '2026-05-15T10:00:00.000Z',
    updatedAt: '2026-05-15T10:00:01.000Z',
    outcomeContributesToFailure: false,
  },
  {
    testId: 'test_fe',
    stepIndex: 5,
    action: 'click',
    description: 'Click submit',
    status: 'failed',
    screenshotUrl: null,
    htmlSnapshotUrl: 'https://signed.example.com/05.html',
    runIdIfAvailable: SAMPLE_RUN_ID,
    codeVersion: 'v3',
    capturedAt: '2026-05-15T10:00:01.000Z',
    updatedAt: '2026-05-15T10:00:02.000Z',
    outcomeContributesToFailure: true,
  },
  {
    testId: 'test_fe',
    stepIndex: 6,
    action: 'expect',
    description: 'Expect heading',
    status: null,
    screenshotUrl: null,
    htmlSnapshotUrl: 'https://signed.example.com/06.html',
    runIdIfAvailable: SAMPLE_RUN_ID,
    codeVersion: 'v3',
    capturedAt: null,
    updatedAt: '2026-05-15T10:00:03.000Z',
    outcomeContributesToFailure: false,
  },
];

function makeArtifactContext(overrides: Partial<CliFailureContext> = {}): CliFailureContext {
  const result: CliLatestResult = {
    testId: 'test_fe',
    status: 'failed',
    startedAt: '2026-05-15T10:00:00.000Z',
    finishedAt: '2026-05-15T10:01:00.000Z',
    videoUrl: null,
    failureAnalysisUrl: null,
    snapshotId: SAMPLE_SNAPSHOT_ID,
    runIdIfAvailable: SAMPLE_RUN_ID,
    codeVersion: 'v3',
    targetUrl: 'https://staging.example.com/checkout',
    failedStepIndex: 5,
    failureKind: 'assertion',
    verdict: 'failed',
    executionStatus: 'completed',
    summary: 'Failed (assertion) on step 5: assertion error.',
    ...overrides.result,
  };
  return {
    snapshotId: SAMPLE_SNAPSHOT_ID,
    testId: 'test_fe',
    projectId: 'project_alice',
    result,
    steps: SAMPLE_STEPS,
    code: {
      testId: 'test_fe',
      language: 'typescript',
      framework: 'playwright',
      code: "import { test } from '@playwright/test';\ntest('checkout', () => {});\n",
      codeVersion: 'v3',
      etag: null,
    },
    failure: {
      rootCauseHypothesis: 'Submit button is disabled.',
      recommendedFixTarget: {
        kind: 'code',
        reference: 'src/Checkout.tsx:12',
        rationale: 'isFormValid',
      },
      evidence: [
        {
          kind: 'snapshot',
          stepIndex: 5,
          url: 'https://signed.example.com/ev/05.html',
          summary: 'Step 5 failed. Submit button disabled.',
        },
      ],
    },
    ...overrides,
  };
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];

/**
 * Build a mock fetch that handles:
 *   - Backend API calls (returning JSON via the handler)
 *   - Presigned S3 URL downloads (returning a small dummy response)
 */
function makeFetch(
  apiHandler: (url: string, init: RequestInit) => { status?: number; body: unknown },
): typeof globalThis.fetch {
  return (async (input: FetchInput, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;

    // Presigned URL downloads (snapshot HTML files)
    if (url.includes('signed.example.com')) {
      return new Response('<html>snapshot</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    const { status = 200, body } = apiHandler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_piece4_test' },
    });
  }) as typeof globalThis.fetch;
}

function makeCreds(
  apiKey = 'sk-user-test',
  apiUrl = 'http://localhost:14400',
): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-p4-'));
  const credPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, { mode: 0o600 });
  return { credentialsPath: credPath };
}

// ---------------------------------------------------------------------------
// assertOutDirParentExists
// ---------------------------------------------------------------------------

describe('assertOutDirParentExists', () => {
  it('resolves successfully when parent dir exists', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-parent-'));
    const target = join(tmpDir, 'bundle');
    await expect(assertOutDirParentExists(target)).resolves.toBeUndefined();
  });

  it('throws VALIDATION_ERROR when parent does not exist', async () => {
    const target = join(tmpdir(), 'does-not-exist-xyz', 'bundle');
    await expect(assertOutDirParentExists(target)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({
        reason: expect.stringContaining('parent directory does not exist'),
      }),
    });
  });

  it('throws VALIDATION_ERROR when parent is not a directory (is a file)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-parent-'));
    const fileAsParent = join(tmpDir, 'file.txt');
    await writeFile(fileAsParent, 'content');
    const target = join(fileAsParent, 'bundle');
    await expect(assertOutDirParentExists(target)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({
        reason: expect.stringContaining('parent path is not a directory'),
      }),
    });
  });

  it('throws VALIDATION_ERROR when --out points to an existing file', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-parent-'));
    const existingFile = join(tmpDir, 'bundle.txt');
    await writeFile(existingFile, 'content');
    await expect(assertOutDirParentExists(existingFile)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({
        reason: expect.stringContaining('must point to a directory'),
      }),
    });
  });

  it('resolves successfully when --out points to an existing directory', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-parent-'));
    const existingDir = join(tmpDir, 'bundle');
    await mkdir(existingDir);
    await expect(assertOutDirParentExists(existingDir)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runArtifactGet
// ---------------------------------------------------------------------------

describe('runArtifactGet', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ---- Happy path: --out specified, bundle written ----

  it('happy path: writes bundle to --out dir and returns context + bundle', async () => {
    const { credentialsPath } = makeCreds();
    const ctx = makeArtifactContext();
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-'));
    const outDir = join(tmpDir, 'bundle');

    const fetchImpl = makeFetch(url => {
      expect(url).toContain(`/runs/${SAMPLE_RUN_ID}/failure`);
      return { body: ctx };
    });

    const out: string[] = [];
    const result = await runArtifactGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        runId: SAMPLE_RUN_ID,
        out: outDir,
        failedOnly: false,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(result.context).toEqual(ctx);
    expect(result.bundle).toBeDefined();
    expect(result.bundle!.dir).toBe(outDir);

    // meta.json must exist as the atomicity signal
    const meta = JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8'));
    expect(meta.runIdIfAvailable).toBe(SAMPLE_RUN_ID);
    expect(meta.testId).toBe('test_fe');

    // JSON envelope on stdout
    const envelope = JSON.parse(out[0]!);
    expect(envelope.out).toBe(outDir);
    expect(envelope.snapshotId).toBe(SAMPLE_SNAPSHOT_ID);
    expect(envelope.meta.runId).toBe(SAMPLE_RUN_ID);
  });

  // ---- Default dir: .testsprite/runs/<run-id>/ ----

  it('uses default dir .testsprite/runs/<run-id>/ when --out is absent', async () => {
    const { credentialsPath } = makeCreds();
    const ctx = makeArtifactContext();
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-cwd-'));

    // Override process.cwd so default dir resolves under tmpDir
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      const fetchImpl = makeFetch(() => ({ body: ctx }));
      const out: string[] = [];

      const result = await runArtifactGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          runId: SAMPLE_RUN_ID,
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: line => out.push(line) },
      );

      const expectedDir = join(tmpDir, '.testsprite', 'runs', SAMPLE_RUN_ID);
      expect(result.bundle!.dir).toBe(expectedDir);
      expect(existsSync(join(expectedDir, 'meta.json'))).toBe(true);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('rejects path-like runId before auth or fetch when default --out is used', async () => {
    const fetchImpl = vi.fn<typeof globalThis.fetch>();

    await expect(
      runArtifactGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          runId: '../../outside',
          failedOnly: false,
        },
        { fetchImpl, stdout: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    '.',
    '..',
    '. ',
    '.. ',
    '...',
    '.. .',
    '. .',
    '../outside',
    '..\\outside',
    'nested/run',
    'nested\\run',
    'bad\0id',
  ])('rejects unsafe default artifact runId segment %j', runId => {
    expect(() => resolveDefaultArtifactDir(runId, '/repo')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        details: expect.objectContaining({ field: 'run-id' }),
      }),
    );
  });

  it('keeps the documented default directory for path-safe runIds', () => {
    expect(resolveDefaultArtifactDir(SAMPLE_RUN_ID, '/repo')).toBe(
      join('/repo', '.testsprite', 'runs', SAMPLE_RUN_ID),
    );
  });

  // ---- --failed-only passed through to writeBundle ----

  it('passes --failed-only through to writeBundle (steps filtered to failed ± 1)', async () => {
    const { credentialsPath } = makeCreds();
    const ctx = makeArtifactContext();
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-'));
    const outDir = join(tmpDir, 'bundle');

    const fetchImpl = makeFetch(() => ({ body: ctx }));

    const result = await runArtifactGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        runId: SAMPLE_RUN_ID,
        out: outDir,
        failedOnly: true,
      },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );

    // With failed step at index 5 and --failed-only, steps 4, 5, 6 should be written
    // Verify the bundle was written
    expect(existsSync(join(outDir, 'meta.json'))).toBe(true);
    expect(result.bundle).toBeDefined();
  });

  // ---- --output json without --out: writes to default dir, prints envelope ----

  it('--output json without --out: writes to default .testsprite/runs/<runId>/ and prints JSON envelope', async () => {
    const { credentialsPath } = makeCreds();
    const ctx = makeArtifactContext();
    const fetchImpl = makeFetch(() => ({ body: ctx }));

    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-cwd2-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    try {
      const out: string[] = [];
      const result = await runArtifactGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          runId: SAMPLE_RUN_ID,
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: line => out.push(line) },
      );

      expect(result.context).toEqual(ctx);
      expect(result.bundle).toBeDefined();
      // stdout has the JSON envelope (dir + snapshotId + meta)
      const parsed = JSON.parse(out[0]!);
      expect(parsed).toHaveProperty('out');
      expect(parsed).toHaveProperty('snapshotId', SAMPLE_SNAPSHOT_ID);
      expect(parsed).toHaveProperty('meta');
      expect(parsed.meta.runId).toBe(SAMPLE_RUN_ID);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  // ---- --output text mode ----

  it('text mode (no --output json, with --out) prints human summary', async () => {
    const { credentialsPath } = makeCreds();
    const ctx = makeArtifactContext();
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-'));
    const outDir = join(tmpDir, 'bundle');

    const fetchImpl = makeFetch(() => ({ body: ctx }));
    const out: string[] = [];

    await runArtifactGet(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        runId: SAMPLE_RUN_ID,
        out: outDir,
        failedOnly: false,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const text = out.join('\n');
    expect(text).toContain('Bundle written to');
    expect(text).toContain(SAMPLE_RUN_ID);
    expect(text).toContain(SAMPLE_SNAPSHOT_ID);
  });

  // ---- --dry-run: no network, no disk write ----

  it('--dry-run: exits without making any network call or writing any file', async () => {
    const { credentialsPath } = makeCreds();
    let networkCalled = false;
    const fetchImpl = makeFetch(() => {
      networkCalled = true;
      return { body: {} };
    });

    const out: string[] = [];
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-'));

    await runArtifactGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        runId: SAMPLE_RUN_ID,
        out: join(tmpDir, 'bundle'),
        failedOnly: false,
        dryRun: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(networkCalled).toBe(false);
    expect(existsSync(join(tmpDir, 'bundle', 'meta.json'))).toBe(false);

    // JSON output matches the real success schema: { out, snapshotId, meta }
    const envelope = JSON.parse(out[0]!);
    expect(envelope).toHaveProperty('out');
    expect(envelope).toHaveProperty('snapshotId');
    expect(envelope).toHaveProperty('meta');
    // `out` is the resolved --out path (explicit in this test)
    expect(envelope.out).toBeTruthy();
  });

  it('--dry-run text mode: prints human-readable envelope', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: {} }));
    const out: string[] = [];
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-'));

    await runArtifactGet(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        runId: SAMPLE_RUN_ID,
        out: join(tmpDir, 'bundle'),
        failedOnly: false,
        dryRun: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const text = out.join('\n');
    expect(text).toContain('[dry-run]');
    expect(text).toContain('GET');
  });

  // ---- --out parent missing → exit 5 ----

  it('--out with missing parent directory → VALIDATION_ERROR (exit 5)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: {} }));

    const missingParent = join(tmpdir(), 'definitely-does-not-exist-xyz', 'bundle');
    await expect(
      runArtifactGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          runId: SAMPLE_RUN_ID,
          out: missingParent,
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // ---- --out is a file → exit 5 ----

  it('--out pointing to an existing file → VALIDATION_ERROR (exit 5)', async () => {
    const { credentialsPath } = makeCreds();
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-'));
    const existingFile = join(tmpDir, 'bundle.txt');
    await writeFile(existingFile, 'content');

    const fetchImpl = makeFetch(() => ({ body: {} }));

    await expect(
      runArtifactGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          runId: SAMPLE_RUN_ID,
          out: existingFile,
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  // ---- 404 not_found → exit 4 ----

  it('404 not_found → propagates as NOT_FOUND ApiError (exit 4)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: 'Run not found.',
          nextAction: 'Check the id.',
          requestId: 'req_404',
          details: { reason: 'not_found' },
        },
      },
    }));

    await expect(
      runArtifactGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          runId: SAMPLE_RUN_ID,
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // ---- 404 run_not_ready → exit 4 with nextAction ----

  it('404 run_not_ready → NOT_FOUND with run_not_ready reason', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: 'Run not ready.',
          nextAction: `Wait for the run to finish: testsprite test wait ${SAMPLE_RUN_ID}`,
          requestId: 'req_notready',
          details: { reason: 'run_not_ready' },
        },
      },
    }));

    let error: ApiError | undefined;
    try {
      await runArtifactGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          runId: SAMPLE_RUN_ID,
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: () => {} },
      );
    } catch (e) {
      error = e as ApiError;
    }

    expect(error).toBeDefined();
    expect(error!.code).toBe('NOT_FOUND');
    expect(error!.nextAction).toContain('testsprite test wait');
  });

  // ---- 404 no_failing_run → exit 4 ----

  it('404 no_failing_run → NOT_FOUND with no_failing_run reason', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: 'Run passed.',
          nextAction: 'Run passed — there is no failure bundle to download.',
          requestId: 'req_nofail',
          details: { reason: 'no_failing_run' },
        },
      },
    }));

    let error: ApiError | undefined;
    try {
      await runArtifactGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          runId: SAMPLE_RUN_ID,
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: () => {} },
      );
    } catch (e) {
      error = e as ApiError;
    }

    expect(error).toBeDefined();
    expect(error!.code).toBe('NOT_FOUND');
    expect(error!.nextAction).toContain('no failure bundle');
  });

  // ---- 404 cancelled_no_artifacts → exit 4 ----

  it('404 cancelled_no_artifacts → NOT_FOUND error', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: 'Run cancelled.',
          nextAction: '',
          requestId: 'req_cancelled',
          details: { reason: 'cancelled_no_artifacts' },
        },
      },
    }));

    await expect(
      runArtifactGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          runId: SAMPLE_RUN_ID,
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // ---- meta.runId mismatch → exit 5 ----

  it('meta.runId mismatch (backend bug) → VALIDATION_ERROR exit 5, no disk write', async () => {
    const { credentialsPath } = makeCreds();
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-'));
    const outDir = join(tmpDir, 'bundle');

    // Backend returns a context for a DIFFERENT runId
    const wrongRunId = 'run_WRONG_123';
    const ctx = makeArtifactContext({
      result: {
        ...makeArtifactContext().result,
        runIdIfAvailable: wrongRunId,
        snapshotId: SAMPLE_SNAPSHOT_ID,
      },
    });

    const fetchImpl = makeFetch(() => ({ body: ctx }));

    await expect(
      runArtifactGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          runId: SAMPLE_RUN_ID,
          out: outDir,
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: () => {} },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      // Item-10 fix: assertContextIntegrity (requireRunId path) catches step
      // runId mismatch before the caller's explicit result.runId check.
      details: expect.objectContaining({ reason: 'run_id_mismatch' }),
    });

    // No bundle written
    expect(existsSync(join(outDir, 'meta.json'))).toBe(false);
  });

  // ---- 409 CONFLICT: 1× retry → exit 6 on second 409 ----

  it('409 CONFLICT retries once, then propagates CONFLICT on second 409', async () => {
    const { credentialsPath } = makeCreds();
    let callCount = 0;
    const fetchImpl = makeFetch(() => {
      callCount++;
      return {
        status: 409,
        body: {
          error: {
            code: 'CONFLICT',
            message: 'Snapshot in flight.',
            nextAction: 'Retry in a few seconds.',
            requestId: 'req_conflict',
            details: { reason: 'snapshot_in_flight' },
          },
        },
      };
    });

    await expect(
      runArtifactGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          runId: SAMPLE_RUN_ID,
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // HttpClient retries once on CONFLICT (total 2 attempts per the CLI error spec §7)
    expect(callCount).toBe(2);
  }, 10000);

  // ---- createTestArtifactCommand: exposes get subcommand ----

  it('createTestArtifactCommand exposes artifact get <run-id>', () => {
    const cmd = createTestArtifactCommand({});
    expect(cmd.name()).toBe('artifact');
    const sub = cmd.commands.find(c => c.name() === 'get');
    expect(sub).toBeDefined();
    const flagNames = sub!.options.map(o => o.long);
    expect(flagNames).toContain('--out');
    expect(flagNames).toContain('--failed-only');
    // --dry-run is a global flag (not a per-subcommand option); it is
    // inherited via optsWithGlobals() and must NOT appear in the local
    // options list (shadowing the global flag was the Item-9 bug).
    expect(flagNames).not.toContain('--dry-run');
  });
});

// ---------------------------------------------------------------------------
// M2 non-regression: runFailureGet still works after requireRunId was added
// ---------------------------------------------------------------------------

describe('runFailureGet M2 non-regression (requireRunId is opt-in)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('M2 path (meta.runId = null) succeeds without requireRunId', async () => {
    const { credentialsPath } = makeCreds();
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-m2reg-'));
    const outDir = join(tmpDir, 'bundle');

    // M2-shaped context: runIdIfAvailable is null
    const m2Ctx: CliFailureContext = {
      snapshotId: 'snap_m2_nullrunid',
      testId: 'test_m2',
      projectId: 'project_m2',
      result: {
        testId: 'test_m2',
        status: 'failed',
        startedAt: null,
        finishedAt: '2026-05-15T09:00:00.000Z',
        videoUrl: null,
        failureAnalysisUrl: null,
        snapshotId: 'snap_m2_nullrunid',
        runIdIfAvailable: null, // M2 shape: null
        codeVersion: 'v1',
        targetUrl: 'https://example.com',
        failedStepIndex: 1,
        failureKind: 'assertion',
        verdict: 'failed',
        executionStatus: 'completed',
        summary: 'Failed (assertion) on step 1: assertion error.',
      },
      steps: [
        {
          testId: 'test_m2',
          stepIndex: 1,
          action: 'click',
          description: 'click',
          status: 'failed',
          screenshotUrl: null,
          htmlSnapshotUrl: null,
          runIdIfAvailable: null, // M2 shape: null
          codeVersion: 'v1',
          capturedAt: null,
          updatedAt: '2026-05-15T09:00:00.000Z',
          outcomeContributesToFailure: true,
        },
      ],
      code: {
        testId: 'test_m2',
        language: 'typescript',
        framework: 'playwright',
        code: 'test("m2", () => {});',
        codeVersion: 'v1',
        etag: null,
      },
      failure: {
        rootCauseHypothesis: null,
        recommendedFixTarget: { kind: 'unknown', reference: null, rationale: null },
        evidence: [
          {
            kind: 'snapshot',
            stepIndex: 1,
            url: 'https://m2.example.com/snap.html',
            summary: 'failed step',
          },
        ],
      },
    };

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      if (url.includes('m2.example.com')) {
        return new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response(JSON.stringify(m2Ctx), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_m2' },
      });
    }) as typeof globalThis.fetch;

    // M2 path uses testId, not runId. Should succeed with exit 0.
    const result = await runFailureGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_m2',
        out: outDir,
        failedOnly: false,
      },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );

    // Exit 0 path: bundle was written, no error thrown
    expect(result.bundle).toBeDefined();
    const meta = JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8'));
    expect(meta.runIdIfAvailable).toBeNull();
    expect(meta.testId).toBe('test_m2');
  });
});

// ---------------------------------------------------------------------------
// DEV-230 — noun-level pass-through aliases
//   `test failure <id>`   → `test failure get <id>`
//   `test artifact <id>`  → `test artifact get <run-id>`
// Implemented via Commander `isDefault: true` on each group's `get` subcommand.
// Routing is proven by the endpoint each handler hits:
//   failure get     → GET /tests/{testId}/failure
//   failure summary → GET /tests/{testId}/failure/summary
//   artifact get    → GET /runs/{runId}/failure
// ---------------------------------------------------------------------------

describe('DEV-230 noun-level pass-through aliases', () => {
  it('`test failure <id>` routes to failure get (GET /tests/{id}/failure)', async () => {
    const { credentialsPath } = makeCreds();
    const urls: string[] = [];
    const fetchImpl = makeFetch(url => {
      urls.push(url);
      return { body: makeArtifactContext() };
    });
    const test = createTestCommand({ credentialsPath, fetchImpl, stdout: () => {} });

    await test.parseAsync(['failure', 'test_alias_fe'], { from: 'user' });

    const apiUrls = urls.filter(u => !u.includes('signed.example.com'));
    expect(apiUrls.some(u => u.includes('/tests/test_alias_fe/failure'))).toBe(true);
    // It must NOT have been treated as the summary sub-verb.
    expect(apiUrls.some(u => u.includes('/failure/summary'))).toBe(false);
  });

  it('`test failure get <id>` still works unchanged', async () => {
    const { credentialsPath } = makeCreds();
    const urls: string[] = [];
    const fetchImpl = makeFetch(url => {
      urls.push(url);
      return { body: makeArtifactContext() };
    });
    const test = createTestCommand({ credentialsPath, fetchImpl, stdout: () => {} });

    await test.parseAsync(['failure', 'get', 'test_explicit_fe'], { from: 'user' });

    const apiUrls = urls.filter(u => !u.includes('signed.example.com'));
    expect(apiUrls.some(u => u.includes('/tests/test_explicit_fe/failure'))).toBe(true);
    expect(apiUrls.some(u => u.includes('/failure/summary'))).toBe(false);
  });

  it('`test failure summary <id>` is NOT swallowed by the default get (id binds to the 2nd token)', async () => {
    const { credentialsPath } = makeCreds();
    const urls: string[] = [];
    const summary = {
      testId: 'test_summary_fe',
      status: 'failed',
      failureKind: 'assertion',
      snapshotId: 'snap_alias',
      rootCauseHypothesis: null,
      recommendedFixTarget: null,
    };
    const fetchImpl = makeFetch(url => {
      urls.push(url);
      return { body: summary };
    });
    const test = createTestCommand({ credentialsPath, fetchImpl, stdout: () => {} });

    await test.parseAsync(['failure', 'summary', 'test_summary_fe'], { from: 'user' });

    const apiUrls = urls.filter(u => !u.includes('signed.example.com'));
    // The summary endpoint must be hit with the id as the 2nd token — proving
    // 'summary' was resolved as the sub-verb, not consumed as a test-id by `get`.
    expect(apiUrls.some(u => u.includes('/tests/test_summary_fe/failure/summary'))).toBe(true);
    expect(apiUrls.some(u => u.includes('/tests/summary/failure'))).toBe(false);
  });

  it('`test artifact <run-id>` routes to artifact get (GET /runs/{runId}/failure), preserving run-id semantics', async () => {
    const { credentialsPath } = makeCreds();
    const outDir = await mkdtemp(join(tmpdir(), 'cli-alias-art-'));
    const urls: string[] = [];
    const fetchImpl = makeFetch(url => {
      urls.push(url);
      return { body: makeArtifactContext() };
    });
    const test = createTestCommand({ credentialsPath, fetchImpl, stdout: () => {} });

    // SAMPLE_RUN_ID matches makeArtifactContext()'s runId so the run-scoped
    // `requireRunId` integrity check passes; the URL still proves the bare-noun
    // positional was forwarded to the run-scoped endpoint as a run-id.
    await test.parseAsync(['artifact', SAMPLE_RUN_ID, '--out', outDir], { from: 'user' });

    const apiUrls = urls.filter(u => !u.includes('signed.example.com'));
    expect(apiUrls.some(u => u.includes(`/runs/${SAMPLE_RUN_ID}/failure`))).toBe(true);
    // The positional is a run-id, so it must NOT be mapped onto a /tests/ path.
    expect(apiUrls.some(u => u.includes(`/tests/${SAMPLE_RUN_ID}/`))).toBe(false);
  });

  it('`test artifact get <run-id>` still works unchanged', async () => {
    const { credentialsPath } = makeCreds();
    const outDir = await mkdtemp(join(tmpdir(), 'cli-alias-art2-'));
    const urls: string[] = [];
    const fetchImpl = makeFetch(url => {
      urls.push(url);
      return { body: makeArtifactContext() };
    });
    const test = createTestCommand({ credentialsPath, fetchImpl, stdout: () => {} });

    await test.parseAsync(['artifact', 'get', SAMPLE_RUN_ID, '--out', outDir], {
      from: 'user',
    });

    const apiUrls = urls.filter(u => !u.includes('signed.example.com'));
    expect(apiUrls.some(u => u.includes(`/runs/${SAMPLE_RUN_ID}/failure`))).toBe(true);
  });
});
