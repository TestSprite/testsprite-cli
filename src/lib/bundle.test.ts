/**
 * Bundle writer unit tests.
 *
 * These exercise the pure helpers (`assertContextIntegrity`,
 * `applyFailedOnly`, `pickCodeExtension`, `buildMeta`,
 * `stepFilenamePrefix`) without filesystem I/O. The integration of
 * `writeBundle` itself is covered in `commands/test.test.ts` (where
 * the full http+fetch path is wired against MSW).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyFailedOnly,
  assertContextIntegrity,
  assertNoEscape,
  BUNDLE_SCHEMA_VERSION,
  buildMeta,
  isBundleOwnedEntry,
  pickCodeExtension,
  resolveBundleDir,
  STREAM_URL_MAX_RETRIES,
  streamUrlToFile,
  stepFilenamePrefix,
  writeBundle,
  type AssertContextIntegrityOptions,
} from './bundle.js';
import type { CliFailureContext } from '../commands/test.js';

const baseCtx: CliFailureContext = {
  snapshotId: 'snap_abc',
  testId: 'test_failed',
  projectId: 'project_alice',
  result: {
    testId: 'test_failed',
    status: 'failed',
    startedAt: null,
    finishedAt: '2026-05-05T12:34:58.000Z',
    videoUrl: 'https://video.example.com/x.mp4',
    failureAnalysisUrl: null,
    snapshotId: 'snap_abc',
    runIdIfAvailable: 'run_abc',
    codeVersion: 'v3',
    targetUrl: 'https://staging.example.com/checkout',
    failedStepIndex: 5,
    failureKind: 'assertion',
    verdict: 'failed',
    executionStatus: 'completed',
    summary: 'Failed (assertion) on step 5: assertion error.',
  },
  steps: [3, 4, 5, 6, 7].map(i => ({
    testId: 'test_failed',
    stepIndex: i,
    action: 'click',
    description: `step ${i}`,
    status: i === 5 ? ('failed' as const) : ('passed' as const),
    screenshotUrl: null,
    htmlSnapshotUrl: `https://signed.example.com/${String(i).padStart(2, '0')}.html`,
    runIdIfAvailable: 'run_abc',
    codeVersion: 'v3',
    capturedAt: null,
    updatedAt: '2026-05-05T12:34:56.000Z',
  })),
  code: {
    testId: 'test_failed',
    language: 'typescript',
    framework: 'playwright',
    code: 'inline',
    codeVersion: 'v3',
    etag: null,
  },
  failure: {
    rootCauseHypothesis: 'submit disabled',
    recommendedFixTarget: { kind: 'unknown', reference: null, rationale: null },
    evidence: [3, 4, 5, 6, 7].map(i => ({
      kind: 'snapshot' as const,
      stepIndex: i,
      url: `https://signed.example.com/ev/${i}.html`,
      summary: `step ${i}`,
    })),
  },
};

describe('assertContextIntegrity', () => {
  it('passes for a well-formed bundle', () => {
    expect(() => assertContextIntegrity(baseCtx, 'req_x')).not.toThrow();
  });

  it('throws on bundle.snapshotId !== result.snapshotId (the §3 invariant)', () => {
    const forged: CliFailureContext = {
      ...baseCtx,
      snapshotId: 'snap_OUTER',
    };
    // Backward-compat: details.reason is still the machine-matchable sentinel.
    // New: details carries expectedSnapshotId + actualSnapshotId; message names them.
    expect(() => assertContextIntegrity(forged, 'req_x')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('snap_OUTER'),
        details: expect.objectContaining({
          reason: 'snapshot_id_mismatch',
          expectedSnapshotId: 'snap_OUTER',
          actualSnapshotId: baseCtx.result.snapshotId,
        }),
      }),
    );
  });

  it('throws when steps disagree on runIdIfAvailable', () => {
    const [first, second] = baseCtx.steps as [
      (typeof baseCtx.steps)[number],
      (typeof baseCtx.steps)[number],
      ...Array<(typeof baseCtx.steps)[number]>,
    ];
    const forged: CliFailureContext = {
      ...baseCtx,
      steps: [
        { ...first, runIdIfAvailable: 'run_a' },
        { ...second, runIdIfAvailable: 'run_b' },
      ],
    };
    // Backward-compat: details.reason is still the machine-matchable sentinel.
    // New: details carries observedRunIds listing all mixed runIds; message names them.
    expect(() => assertContextIntegrity(forged, 'req_x')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('run_a'),
        details: expect.objectContaining({
          reason: 'run_id_mismatch',
          observedRunIds: expect.arrayContaining(['run_a', 'run_b']),
        }),
      }),
    );
  });

  it('surfaces both run IDs in message and details (dogfood L152)', () => {
    // This is the exact L152 scenario: backend returns a bundle where steps
    // carry a different runId than what the result row records. The error
    // must name BOTH ids so the operator (and support) can diagnose whether
    // the mismatch is data corruption or a comparison bug.
    const [first, second] = baseCtx.steps as [
      (typeof baseCtx.steps)[number],
      (typeof baseCtx.steps)[number],
      ...Array<(typeof baseCtx.steps)[number]>,
    ];
    const forged: CliFailureContext = {
      ...baseCtx,
      steps: [
        { ...first, runIdIfAvailable: 'run_xyz' },
        { ...second, runIdIfAvailable: 'run_abc' },
      ],
    };
    let thrown: Error | undefined;
    try {
      assertContextIntegrity(forged, 'req_x');
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({
        reason: 'run_id_mismatch',
        observedRunIds: expect.arrayContaining(['run_xyz', 'run_abc']),
      }),
    });
    // The human-readable message must name at least one of the offending ids.
    expect(thrown!.message).toMatch(/run_xyz|run_abc/);
  });

  it('throws when evidence is non-empty but does not include the failed step (§6.2)', () => {
    const forged: CliFailureContext = {
      ...baseCtx,
      failure: {
        ...baseCtx.failure,
        // Evidence covers neighbors only; failed step (5) absent.
        evidence: baseCtx.failure.evidence.filter(e => e.stepIndex !== 5),
      },
    };
    expect(() => assertContextIntegrity(forged, 'req_x')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        details: expect.objectContaining({ reason: 'evidence_missing_failed_step' }),
      }),
    );
  });

  // Per codex round-1 P2: every embedded testId must equal ctx.testId.
  // The §6.X failure-context wire shape duplicates `testId` in
  // `result`, `code`, and each step so a bundle stitched from rows of
  // two different tests is detectable without external state.
  it('throws when result.testId !== ctx.testId (codex P2)', () => {
    const forged: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, testId: 'test_OTHER' },
    };
    // Backward-compat: reason sentinel preserved.
    // New: details carries expectedTestId + actualTestId; message names them.
    expect(() => assertContextIntegrity(forged, 'req_x')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('test_OTHER'),
        details: expect.objectContaining({
          reason: 'test_id_mismatch',
          expectedTestId: baseCtx.testId,
          actualTestId: 'test_OTHER',
        }),
      }),
    );
  });

  it('throws when code.testId !== ctx.testId (codex P2)', () => {
    const forged: CliFailureContext = {
      ...baseCtx,
      code: { ...baseCtx.code, testId: 'test_OTHER' },
    };
    expect(() => assertContextIntegrity(forged, 'req_x')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('test_OTHER'),
        details: expect.objectContaining({
          reason: 'test_id_mismatch',
          expectedTestId: baseCtx.testId,
          actualTestId: 'test_OTHER',
        }),
      }),
    );
  });

  it('throws when any step.testId !== ctx.testId (codex P2)', () => {
    const [first, ...rest] = baseCtx.steps as [
      (typeof baseCtx.steps)[number],
      ...Array<(typeof baseCtx.steps)[number]>,
    ];
    const forged: CliFailureContext = {
      ...baseCtx,
      steps: [{ ...first, testId: 'test_OTHER' }, ...rest],
    };
    expect(() => assertContextIntegrity(forged, 'req_x')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('test_OTHER'),
        details: expect.objectContaining({
          reason: 'test_id_mismatch',
          expectedTestId: baseCtx.testId,
          actualTestId: 'test_OTHER',
        }),
      }),
    );
  });

  it('throws when result.codeVersion and code.codeVersion are both set but disagree', () => {
    // §6.7: code is "version pinned to result.codeVersion." A bundle
    // where the two versions disagree is exactly the drift the failure
    // bundle exists to prevent — fix the wrong code, ship the wrong
    // suggestion. Treat as corrupt.
    const forged: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, codeVersion: 'v3' },
      code: { ...baseCtx.code, codeVersion: 'v4' },
    };
    // Backward-compat: reason sentinel preserved.
    // New: details carries expectedCodeVersion + actualCodeVersion; message names them.
    expect(() => assertContextIntegrity(forged, 'req_x')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('v4'),
        details: expect.objectContaining({
          reason: 'code_version_mismatch',
          expectedCodeVersion: 'v3',
          actualCodeVersion: 'v4',
        }),
      }),
    );
  });

  it('allows codeVersion mismatch when one side is null (M2 transition surface)', () => {
    // M2 backend hasn't shipped versioning yet — both result and code
    // codeVersion can be null. The integrity check should only fire on
    // a disagreement between two non-null values, not on partial
    // adoption.
    const halfway: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, codeVersion: null },
      code: { ...baseCtx.code, codeVersion: 'v3' },
    };
    expect(() => assertContextIntegrity(halfway, 'req_x')).not.toThrow();
  });

  it('allows empty evidence (the legal "no diagnosis available" branch)', () => {
    const ok: CliFailureContext = {
      ...baseCtx,
      failure: { ...baseCtx.failure, evidence: [] },
    };
    expect(() => assertContextIntegrity(ok, 'req_x')).not.toThrow();
  });

  it('allows null failedStepIndex even when evidence is non-empty (assertion-level failure)', () => {
    // When the test failed but no per-step row carried status:failed,
    // the bundle ships failedStepIndex:null. The §6.2 invariant only
    // applies when failedStepIndex is non-null.
    const ok: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, failedStepIndex: null },
    };
    expect(() => assertContextIntegrity(ok, 'req_x')).not.toThrow();
  });

  // M3.3 piece-4 — requireRunId option (opt-in, does not affect M2 callers)

  it('requireRunId: passes when runIdIfAvailable is non-null', () => {
    // baseCtx has runIdIfAvailable: 'run_abc'
    const opts: AssertContextIntegrityOptions = { requireRunId: true };
    expect(() => assertContextIntegrity(baseCtx, 'req_x', opts)).not.toThrow();
  });

  it('requireRunId: throws run_id_missing when runIdIfAvailable is null', () => {
    const noRunId: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, runIdIfAvailable: null },
    };
    const opts: AssertContextIntegrityOptions = { requireRunId: true };
    expect(() => assertContextIntegrity(noRunId, 'req_x', opts)).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        details: expect.objectContaining({ reason: 'run_id_missing' }),
      }),
    );
  });

  it('requireRunId: is opt-in — M2 callers without the option pass with null runId', () => {
    // This is the M2 non-regression: existing callers pass no opts → no change in behavior.
    const m2Ctx: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, runIdIfAvailable: null },
      steps: baseCtx.steps.map(s => ({ ...s, runIdIfAvailable: null })),
    };
    // Without opts (M2 path) — should not throw
    expect(() => assertContextIntegrity(m2Ctx, 'req_x')).not.toThrow();
    // Explicitly opting out — same result
    expect(() => assertContextIntegrity(m2Ctx, 'req_x', {})).not.toThrow();
    expect(() => assertContextIntegrity(m2Ctx, 'req_x', { requireRunId: false })).not.toThrow();
  });

  // Item-10 forged-context tests — run-scoped step assertions
  //
  // These guard the case where a backend bug (or adversarial response)
  // stitches step artifacts from a different run into a result envelope.
  // Without the step-level check, `assertContextIntegrity` only detected
  // "steps disagree with each other" — it accepted a bundle where all steps
  // agreed on `run_other` while result carried `run_abc`.

  it('Item-10: rejects when result.runId is correct but step.runId is a different run', () => {
    // Backend stitches step artifacts from "run_other" into a result for "run_abc".
    // All steps agree with each other (set-size check passes) but disagree with result.
    const forged: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, runIdIfAvailable: 'run_abc' },
      steps: baseCtx.steps.map(s => ({ ...s, runIdIfAvailable: 'run_other' })),
    };
    // Backward-compat: reason sentinel preserved.
    // New: details carries expectedRunId + actualRunId; message names them.
    expect(() => assertContextIntegrity(forged, 'req_x', { requireRunId: true })).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('run_abc'),
        details: expect.objectContaining({
          reason: 'run_id_mismatch',
          expectedRunId: 'run_abc',
          actualRunId: 'run_other',
        }),
      }),
    );
  });

  it('Item-10: rejects when a step has runIdIfAvailable === null (run-scoped path)', () => {
    // A null step run ID is unacceptable in the run-scoped path: the
    // backend must stamp every step with the exact run it belongs to.
    // The early "distinct non-null runIds" check tolerates null (a null
    // is a legacy un-stamped row, not cross-run stitching — dogfood
    // 2026-06-04), so with a single real runId it does NOT fire. The
    // run-scoped per-step equality check then catches the null step and
    // names the exact offending step.
    const forged: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, runIdIfAvailable: 'run_abc' },
      steps: [
        { ...baseCtx.steps[0]!, runIdIfAvailable: null }, // null step
        ...baseCtx.steps.slice(1).map(s => ({ ...s, runIdIfAvailable: 'run_abc' })),
      ],
    };
    expect(() => assertContextIntegrity(forged, 'req_x', { requireRunId: true })).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        details: expect.objectContaining({
          reason: 'run_id_mismatch',
          expectedRunId: 'run_abc',
          actualRunId: null,
        }),
      }),
    );
  });

  it('test-scoped path tolerates a mix of one real runId and nulls (dogfood 2026-06-04)', () => {
    // FE Portal step rows accumulate across runs; rows written before
    // runId stamping carry `runIdIfAvailable: null`. A test run more than
    // once across the M3.1 cutover therefore legitimately has one real
    // runId plus several nulls. The test-scoped failure bundle
    // (`test failure get <test-id>`, requireRunId unset) must NOT reject
    // it — the null is durable, so the old "re-fetch usually succeeds"
    // hint never recovered. Only ≥2 *real* runIds are a true conflict.
    const tolerated: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, runIdIfAvailable: 'run_abc' },
      steps: [
        { ...baseCtx.steps[0]!, runIdIfAvailable: 'run_abc' },
        { ...baseCtx.steps[1]!, runIdIfAvailable: null },
      ],
    };
    expect(() => assertContextIntegrity(tolerated, 'req_x')).not.toThrow();
  });

  it('Item-10: rejects when ALL steps have a uniform but wrong runId (requireRunId path)', () => {
    // When all steps agree on a single runId but that runId differs from result.runIdIfAvailable,
    // the "steps disagree among themselves" check passes (set size = 1) but the
    // requireRunId per-step check fires, surfacing expectedRunId + actualRunId.
    const forged: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, runIdIfAvailable: 'run_abc' },
      steps: baseCtx.steps.map(s => ({ ...s, runIdIfAvailable: 'run_other' })),
    };
    // All steps null-uniform: use a separate ctx where all steps share null
    // so the "mixed set" check doesn't fire and only requireRunId fires.
    const forgedAllNull: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, runIdIfAvailable: 'run_abc' },
      steps: baseCtx.steps.map(s => ({ ...s, runIdIfAvailable: null })),
    };
    // New: details carries expectedRunId + actualRunId (null).
    expect(() =>
      assertContextIntegrity(forgedAllNull, 'req_x', { requireRunId: true }),
    ).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('run_abc'),
        details: expect.objectContaining({
          reason: 'run_id_mismatch',
          expectedRunId: 'run_abc',
          actualRunId: null,
        }),
      }),
    );
    // When forged (all steps 'run_other'), uses requireRunId path since set size = 1.
    expect(() => assertContextIntegrity(forged, 'req_x', { requireRunId: true })).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('run_abc'),
        details: expect.objectContaining({
          reason: 'run_id_mismatch',
          expectedRunId: 'run_abc',
          actualRunId: 'run_other',
        }),
      }),
    );
  });

  it('Item-10: rejects when step.codeVersion disagrees with result.codeVersion', () => {
    // Mixed version bundle — step was captured at v2, result at v3.
    const forged: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, runIdIfAvailable: 'run_abc', codeVersion: 'v3' },
      steps: [
        { ...baseCtx.steps[0]!, runIdIfAvailable: 'run_abc', codeVersion: 'v2' }, // wrong version
        ...baseCtx.steps
          .slice(1)
          .map(s => ({ ...s, runIdIfAvailable: 'run_abc', codeVersion: 'v3' })),
      ],
    };
    // Backward-compat: reason sentinel preserved.
    // New: details carries expectedCodeVersion + actualCodeVersion; message names them.
    expect(() => assertContextIntegrity(forged, 'req_x', { requireRunId: true })).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('v3'),
        details: expect.objectContaining({
          reason: 'code_version_mismatch',
          expectedCodeVersion: 'v3',
          actualCodeVersion: 'v2',
        }),
      }),
    );
  });

  it('Item-10 backward compat: M2 context (steps.runId = null, no requireRunId) still passes', () => {
    // M2-shaped context: all runId fields are null. Without requireRunId: true,
    // the step-level checks must not fire so M2 callers are unaffected.
    const m2Latest: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, runIdIfAvailable: null },
      steps: baseCtx.steps.map(s => ({ ...s, runIdIfAvailable: null })),
    };
    // No requireRunId → should not throw
    expect(() => assertContextIntegrity(m2Latest, 'req_x')).not.toThrow();
    expect(() => assertContextIntegrity(m2Latest, 'req_x', {})).not.toThrow();
    expect(() => assertContextIntegrity(m2Latest, 'req_x', { requireRunId: false })).not.toThrow();
  });
});

describe('applyFailedOnly', () => {
  it('keeps the failed step ± 1 and drops outside-window steps', () => {
    const out = applyFailedOnly(baseCtx);
    expect(out.steps.map(s => s.stepIndex)).toEqual([4, 5, 6]);
    // Evidence is filtered to the same window.
    expect(out.failure.evidence.map(e => e.stepIndex)).toEqual([4, 5, 6]);
  });

  it('returns the bundle unchanged when failedStepIndex is null', () => {
    const ctx: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, failedStepIndex: null },
    };
    const out = applyFailedOnly(ctx);
    expect(out).toBe(ctx);
  });
});

describe('pickCodeExtension', () => {
  it('language drives the choice', () => {
    expect(pickCodeExtension('python', 'pytest')).toBe('py');
    expect(pickCodeExtension('typescript', 'playwright')).toBe('ts');
    expect(pickCodeExtension('javascript', 'playwright')).toBe('js');
  });

  it('falls back to Python when the language is unknown (both frameworks are Python)', () => {
    expect(pickCodeExtension('opaque', 'pytest')).toBe('py');
    expect(pickCodeExtension('opaque', 'playwright')).toBe('py');
  });
});

describe('stepFilenamePrefix', () => {
  it('zero-pads to 2 digits for index < 100', () => {
    expect(stepFilenamePrefix(1)).toBe('01');
    expect(stepFilenamePrefix(5)).toBe('05');
    expect(stepFilenamePrefix(99)).toBe('99');
  });

  it('widens to 3 digits at index 100 (never truncates)', () => {
    // Per §7.2: "Step 100+ widens to three digits". Truncating would
    // collide with another step's prefix and corrupt the filename
    // map an agent uses to read the bundle.
    expect(stepFilenamePrefix(100)).toBe('100');
    expect(stepFilenamePrefix(999)).toBe('999');
  });
});

describe('buildMeta', () => {
  it("mirrors the bundle's identity card", () => {
    const meta = buildMeta(baseCtx, new Date('2026-05-05T12:35:01.000Z'));
    expect(meta.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(meta.snapshotId).toBe(baseCtx.snapshotId);
    expect(meta.testId).toBe(baseCtx.testId);
    expect(meta.projectId).toBe(baseCtx.projectId);
    expect(meta.codeVersion).toBe(baseCtx.code.codeVersion);
    expect(meta.runIdIfAvailable).toBe(baseCtx.result.runIdIfAvailable);
    expect(meta.targetUrl).toBe(baseCtx.result.targetUrl);
    expect(meta.failedStepIndex).toBe(baseCtx.result.failedStepIndex);
    expect(meta.failureKind).toBe(baseCtx.result.failureKind);
    expect(meta.capturedAt).toBe(baseCtx.result.finishedAt);
    expect(meta.fetchedAt).toBe('2026-05-05T12:35:01.000Z');
  });

  it('uses result.codeVersion when code.codeVersion is null', () => {
    const ctx: CliFailureContext = {
      ...baseCtx,
      code: { ...baseCtx.code, codeVersion: null },
      result: { ...baseCtx.result, codeVersion: 'v_from_result' },
    };
    expect(buildMeta(ctx).codeVersion).toBe('v_from_result');
  });
});

describe('resolveBundleDir', () => {
  it('rejects an empty path with VALIDATION_ERROR', () => {
    expect(() => resolveBundleDir('')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        nextAction: expect.stringContaining('--out'),
      }),
    );
  });

  it('resolves a relative path against cwd', () => {
    const out = resolveBundleDir('./tmp/x');
    expect(out.endsWith('/tmp/x')).toBe(true);
    expect(out.startsWith('/')).toBe(true);
  });

  it('strips a trailing slash', () => {
    const out = resolveBundleDir('/tmp/x/');
    expect(out).toBe('/tmp/x');
  });
});

describe('streamUrlToFile retry', () => {
  const noSleep = () => Promise.resolve();

  it('succeeds on the first attempt: file written, fetchImpl called once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stream-test-'));
    const dest = join(dir, 'out.bin');
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response('hello', { status: 200 });
    };
    await streamUrlToFile('https://example.com/x', dest, fetchImpl as typeof globalThis.fetch, {
      sleep: noSleep,
    });
    expect(calls).toBe(1);
  });

  it('retries on transport error and succeeds: fetchImpl called twice, file written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stream-test-'));
    const dest = join(dir, 'out.bin');
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET socket hang up');
      return new Response('retried-content', { status: 200 });
    };
    await streamUrlToFile('https://example.com/x', dest, fetchImpl as typeof globalThis.fetch, {
      sleep: noSleep,
    });
    expect(calls).toBe(2);
  });

  it('throws TransportError after all retries exhausted', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      throw new Error('ENETUNREACH dns lookup failed');
    };
    await expect(
      streamUrlToFile(
        'https://example.com/x',
        '/tmp/will-not-be-written',
        fetchImpl as typeof globalThis.fetch,
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({
      name: 'TransportError',
      message: expect.stringContaining('ENETUNREACH'),
    });
    expect(calls).toBe(STREAM_URL_MAX_RETRIES);
  });

  it('does NOT retry a non-2xx HTTP response (expired presigned URL)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response('Forbidden', { status: 403 });
    };
    await expect(
      streamUrlToFile(
        'https://example.com/x',
        '/tmp/will-not-be-written',
        fetchImpl as typeof globalThis.fetch,
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(calls).toBe(1);
  });

  it('sleeps between retries', async () => {
    const sleepDelays: number[] = [];
    const fetchImpl = async () => {
      throw new Error('flaky');
    };
    await expect(
      streamUrlToFile(
        'https://example.com/x',
        '/tmp/will-not-be-written',
        fetchImpl as typeof globalThis.fetch,
        {
          sleep: ms => {
            sleepDelays.push(ms);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow();
    expect(sleepDelays).toHaveLength(STREAM_URL_MAX_RETRIES - 1);
    expect(sleepDelays.every(d => d > 0)).toBe(true);
  });
});

describe('isBundleOwnedEntry', () => {
  it('owns the fixed bundle file set', () => {
    for (const entry of [
      'result.json',
      'failure.json',
      'video.mp4',
      'meta.json',
      'steps',
      '.tmp',
      '.partial',
    ]) {
      expect(isBundleOwnedEntry(entry)).toBe(true);
    }
  });

  it('owns code.<ext> for any single-token extension', () => {
    expect(isBundleOwnedEntry('code.ts')).toBe(true);
    expect(isBundleOwnedEntry('code.js')).toBe(true);
    expect(isBundleOwnedEntry('code.py')).toBe(true);
  });

  it('does not own foreign entries', () => {
    expect(isBundleOwnedEntry('notes.txt')).toBe(false);
    expect(isBundleOwnedEntry('src')).toBe(false);
    expect(isBundleOwnedEntry('.git')).toBe(false);
    expect(isBundleOwnedEntry('code.tar.gz')).toBe(false);
    expect(isBundleOwnedEntry('mycode.ts')).toBe(false);
    expect(isBundleOwnedEntry('code.')).toBe(false);
  });
});

describe('step artifact path validation', () => {
  // A fetchImpl that fails the test if called — proves validation rejects
  // before any write happens.
  const throwIfFetched = (() => {
    throw new Error('fetchImpl must not be called — validation should reject first');
  }) as unknown as typeof globalThis.fetch;

  // Single-step context that passes assertContextIntegrity (no video, no
  // evidence, failedStepIndex null) so the only thing under test is the
  // step's stepIndex flowing into writeStepArtifacts.
  function stepCtx(stepIndex: unknown, htmlSnapshotUrl: string | null = null): CliFailureContext {
    return {
      ...baseCtx,
      result: { ...baseCtx.result, videoUrl: null, failedStepIndex: null },
      steps: [
        {
          ...baseCtx.steps[0]!,
          stepIndex: stepIndex as number,
          screenshotUrl: null,
          htmlSnapshotUrl,
          runIdIfAvailable: 'run_abc',
        },
      ],
      failure: { ...baseCtx.failure, evidence: [] },
    };
  }

  it('writeBundle rejects a malformed stepIndex and writes nothing outside the bundle dir', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'bundle-test-'));
    const dir = join(parent, 'bundle');
    // From <dir>/.tmp/steps, three "../" segments resolve above the bundle dir.
    const forged = stepCtx('../../../escaped', 'https://signed.example.com/x.html');
    const okFetch = (async () =>
      new Response('<html>planted</html>', { status: 200 })) as unknown as typeof globalThis.fetch;
    await expect(
      writeBundle(forged, { dir, failedOnly: false, fetchImpl: okFetch }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'stepIndex' }),
    });
    // The planted file must NOT exist outside the bundle dir.
    expect(existsSync(join(parent, 'escaped-snapshot.html'))).toBe(false);
  });

  it('writeBundle rejects a non-integer stepIndex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-test-'));
    await expect(
      writeBundle(stepCtx(1.5), { dir, failedOnly: false, fetchImpl: throwIfFetched }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'stepIndex' }),
    });
  });

  it('writeBundle rejects a negative stepIndex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-test-'));
    await expect(
      writeBundle(stepCtx(-1), { dir, failedOnly: false, fetchImpl: throwIfFetched }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'stepIndex' }),
    });
  });

  it('writeBundle rejects a malformed evidence.kind', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'bundle-test-'));
    const dir = join(parent, 'bundle');
    const forged: CliFailureContext = {
      ...baseCtx,
      result: { ...baseCtx.result, videoUrl: null, failedStepIndex: 3 },
      steps: [
        {
          ...baseCtx.steps[0]!,
          stepIndex: 3,
          screenshotUrl: null,
          htmlSnapshotUrl: null,
          runIdIfAvailable: 'run_abc',
        },
      ],
      failure: {
        ...baseCtx.failure,
        evidence: [
          {
            kind: '../../../evil' as unknown as 'snapshot',
            stepIndex: 3,
            url: 'https://signed.example.com/ev/3.html',
            summary: 's',
          },
        ],
      },
    };
    const okFetch = (async () =>
      new Response('planted', { status: 200 })) as unknown as typeof globalThis.fetch;
    await expect(
      writeBundle(forged, { dir, failedOnly: false, fetchImpl: okFetch }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'kind' }),
    });
  });

  it('writeBundle writes a well-formed bundle (guards do not break the happy path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-test-'));
    const res = await writeBundle(stepCtx(3), {
      dir,
      failedOnly: false,
      fetchImpl: throwIfFetched,
    });
    expect(res.files).toContain('meta.json');
    expect(existsSync(join(res.dir, 'meta.json'))).toBe(true);
  });

  describe('commit sweep ownership (data-loss guard)', () => {
    it('preserves pre-existing foreign files and directories in the --out dir', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bundle-test-'));
      writeFileSync(join(dir, 'notes.txt'), 'important notes\n', 'utf8');
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'app.js'), "console.log('app')\n", 'utf8');

      const res = await writeBundle(stepCtx(3), {
        dir,
        failedOnly: false,
        fetchImpl: throwIfFetched,
      });

      // The bundle landed…
      expect(existsSync(join(res.dir, 'meta.json'))).toBe(true);
      expect(existsSync(join(res.dir, 'result.json'))).toBe(true);
      // …and the user's unrelated files survived the commit sweep.
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('important notes\n');
      expect(readFileSync(join(dir, 'src', 'app.js'), 'utf8')).toBe("console.log('app')\n");
    });

    it('still sweeps a stale bundle-owned video.mp4 the new bundle does not write', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bundle-test-'));
      writeFileSync(join(dir, 'video.mp4'), 'stale-bytes', 'utf8');

      // stepCtx has videoUrl: null → the fresh bundle ships no video.
      await writeBundle(stepCtx(3), { dir, failedOnly: false, fetchImpl: throwIfFetched });

      expect(existsSync(join(dir, 'video.mp4'))).toBe(false);
    });

    it('sweeps a stale code file with a different extension than the new bundle writes', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bundle-test-'));
      writeFileSync(join(dir, 'code.py'), '# stale python code\n', 'utf8');

      // baseCtx.code.language is 'typescript' → the fresh bundle writes code.ts.
      await writeBundle(stepCtx(3), { dir, failedOnly: false, fetchImpl: throwIfFetched });

      expect(existsSync(join(dir, 'code.ts'))).toBe(true);
      expect(existsSync(join(dir, 'code.py'))).toBe(false);
    });
  });

  describe('assertNoEscape', () => {
    it('returns the resolved path for an in-bounds segment', () => {
      const base = mkdtempSync(join(tmpdir(), 'bundle-test-'));
      expect(assertNoEscape(base, '01-snapshot.html')).toBe(join(base, '01-snapshot.html'));
    });

    it('throws VALIDATION_ERROR for an out-of-bounds segment', () => {
      const base = mkdtempSync(join(tmpdir(), 'bundle-test-'));
      expect(() => assertNoEscape(base, '../../../evil')).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    });

    it('throws VALIDATION_ERROR for an absolute segment', () => {
      const base = mkdtempSync(join(tmpdir(), 'bundle-test-'));
      expect(() => assertNoEscape(base, '/etc/evil')).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    });
  });
});
