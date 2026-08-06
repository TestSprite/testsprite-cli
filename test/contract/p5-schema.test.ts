/**
 * P5 schema-contract test.
 *
 * Per the CLI validation spec §4 P5 Layer A:
 *
 *   "MSW happy path: full bundle returned; CLI writes the §6.7 layout
 *    under a tmp dir; every file present; `meta.json` matches the
 *    wire payload. Atomicity hard-fail: a forged response with a
 *    mismatched per-file `snapshotId` makes the test suite fail (this
 *    is the FailureContext spec §3 invariants in test form)."
 *
 * Approach matches `p4-schema.test.ts` — hand-rolled strict validators
 * mirror the `FailureContext` / `FailureBlock` / `FixTarget` /
 * `Evidence` shapes from the CLI OpenAPI spec. No `ajv` runtime; the
 * contract is already specified once in YAML and once in CLI types,
 * and these validators are the third gate.
 */

import { describe, expect, it } from 'vitest';
import type {
  CliFailureContext,
  CliFailureBlock,
  CliFixTarget,
  CliEvidence,
} from '../../src/commands/test.js';
import {
  failureContextFixture,
  failureContextNoAnalysisFixture,
  FIXTURE_TEST_ID_FAILED,
  FIXTURE_TEST_ID_NO_ANALYSIS,
} from '../mock-backend/fixtures.js';
import { mockBackend } from '../mock-backend/index.js';

mockBackend.installLifecycle();

const FIX_KINDS = new Set<unknown>(['code', 'selector', 'data', 'env', 'unknown']);
const EVIDENCE_KINDS = new Set<unknown>(['screenshot', 'snapshot', 'log', 'network', 'console']);

const FAILURE_CONTEXT_REQUIRED = [
  'snapshotId',
  'testId',
  'projectId',
  'result',
  'steps',
  'code',
  'failure',
] as const;

const FIX_TARGET_REQUIRED = ['kind', 'reference', 'rationale'] as const;
const EVIDENCE_REQUIRED = ['kind', 'stepIndex', 'url', 'summary'] as const;
const FAILURE_BLOCK_REQUIRED = ['rootCauseHypothesis', 'recommendedFixTarget', 'evidence'] as const;

function expectKeysMatch(value: Record<string, unknown>, allowed: Set<string>, label: string) {
  for (const key of Object.keys(value)) {
    expect(allowed.has(key), `${label}: unexpected extra field "${key}"`).toBe(true);
  }
}

function expectRequired(
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  label: string,
) {
  for (const field of required) {
    expect(field in value, `${label}: missing required field "${field}"`).toBe(true);
  }
}

function expectStringOrNull(v: unknown, label: string) {
  if (v === null) return;
  expect(typeof v, label).toBe('string');
}

function validateFixTarget(value: unknown, label = 'FixTarget'): asserts value is CliFixTarget {
  expect(value, `${label}: must be an object`).toBeTypeOf('object');
  expect(value, `${label}: not null`).not.toBeNull();
  const obj = value as Record<string, unknown>;
  expectRequired(obj, FIX_TARGET_REQUIRED, label);
  expectKeysMatch(obj, new Set(FIX_TARGET_REQUIRED), label);
  expect(FIX_KINDS.has(obj.kind), `${label}.kind`).toBe(true);
  expectStringOrNull(obj.reference, `${label}.reference`);
  expectStringOrNull(obj.rationale, `${label}.rationale`);
}

function validateEvidence(value: unknown, label = 'Evidence'): asserts value is CliEvidence {
  expect(value, `${label}: must be an object`).toBeTypeOf('object');
  expect(value, `${label}: not null`).not.toBeNull();
  const obj = value as Record<string, unknown>;
  expectRequired(obj, EVIDENCE_REQUIRED, label);
  expectKeysMatch(obj, new Set(EVIDENCE_REQUIRED), label);
  expect(EVIDENCE_KINDS.has(obj.kind), `${label}.kind`).toBe(true);
  expect(typeof obj.stepIndex, `${label}.stepIndex`).toBe('number');
  expect((obj.stepIndex as number) >= 1, `${label}.stepIndex >= 1`).toBe(true);
  expect(typeof obj.url, `${label}.url`).toBe('string');
  expect((obj.url as string).startsWith('https://'), `${label}.url is https`).toBe(true);
  // §6.1: summary is non-nullable. M2 ships a deterministic
  // synthesizer until the LLM pipeline lands.
  expect(typeof obj.summary, `${label}.summary`).toBe('string');
  expect((obj.summary as string).length, `${label}.summary non-empty`).toBeGreaterThan(0);
}

function validateFailureBlock(
  value: unknown,
  label = 'FailureBlock',
): asserts value is CliFailureBlock {
  expect(value, `${label}: must be an object`).toBeTypeOf('object');
  expect(value, `${label}: not null`).not.toBeNull();
  const obj = value as Record<string, unknown>;
  expectRequired(obj, FAILURE_BLOCK_REQUIRED, label);
  expectKeysMatch(obj, new Set(FAILURE_BLOCK_REQUIRED), label);
  expectStringOrNull(obj.rootCauseHypothesis, `${label}.rootCauseHypothesis`);
  validateFixTarget(obj.recommendedFixTarget, `${label}.recommendedFixTarget`);
  expect(Array.isArray(obj.evidence), `${label}.evidence`).toBe(true);
  for (const [i, ev] of (obj.evidence as unknown[]).entries()) {
    validateEvidence(ev, `${label}.evidence[${i}]`);
  }
}

function validateFailureContext(
  value: unknown,
  label = 'FailureContext',
): asserts value is CliFailureContext {
  expect(value, `${label}: must be an object`).toBeTypeOf('object');
  expect(value, `${label}: not null`).not.toBeNull();
  const obj = value as Record<string, unknown>;
  expectRequired(obj, FAILURE_CONTEXT_REQUIRED, label);
  expectKeysMatch(obj, new Set(FAILURE_CONTEXT_REQUIRED), label);
  expect(typeof obj.snapshotId, `${label}.snapshotId`).toBe('string');
  expect(typeof obj.testId, `${label}.testId`).toBe('string');
  expect(typeof obj.projectId, `${label}.projectId`).toBe('string');
  validateFailureBlock(obj.failure, `${label}.failure`);
  // result/steps/code shapes are validated in p4-schema.test.ts —
  // here we only assert the cross-bundle identity invariants.
  const result = obj.result as Record<string, unknown>;
  expect(result.snapshotId, `${label}: result.snapshotId === bundle.snapshotId`).toBe(
    obj.snapshotId,
  );
  expect(Array.isArray(obj.steps), `${label}.steps array`).toBe(true);
}

describe('P5 schema contract — FailureContext fixtures match the OpenAPI shape', () => {
  it('failureContextFixture passes the FailureContext validator', () => {
    validateFailureContext(failureContextFixture);
  });

  it('failureContextNoAnalysisFixture passes (no-analysis branch is legal per §4)', () => {
    validateFailureContext(failureContextNoAnalysisFixture);
    expect(failureContextNoAnalysisFixture.failure.rootCauseHypothesis).toBeNull();
    expect(failureContextNoAnalysisFixture.failure.evidence).toEqual([]);
  });

  it('§3 atomicity: bundle.snapshotId equals result.snapshotId', () => {
    expect(failureContextFixture.snapshotId).toBe(failureContextFixture.result.snapshotId);
  });

  it('§6.4: every step shares runIdIfAvailable (or all null)', () => {
    const runIds = new Set(
      failureContextFixture.steps.map(s => s.runIdIfAvailable).filter(v => v !== null),
    );
    expect(runIds.size).toBeLessThanOrEqual(1);
  });

  it('§6.2: when evidence is non-empty, it includes failedStepIndex', () => {
    const failedIdx = failureContextFixture.result.failedStepIndex;
    if (failureContextFixture.failure.evidence.length > 0 && failedIdx !== null) {
      const hasFailed = failureContextFixture.failure.evidence.some(e => e.stepIndex === failedIdx);
      expect(hasFailed).toBe(true);
    }
  });

  it('FIXTURE_TEST_ID_FAILED is the failed-bundle id (sanity for the MSW handler)', () => {
    expect(failureContextFixture.testId).toBe(FIXTURE_TEST_ID_FAILED);
  });

  it('FIXTURE_TEST_ID_NO_ANALYSIS is the no-analysis bundle id', () => {
    expect(failureContextNoAnalysisFixture.testId).toBe(FIXTURE_TEST_ID_NO_ANALYSIS);
  });
});

// ---- CLI surface contract: what runFailureGet returns ----

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFailureGet } from '../../src/commands/test.js';

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-p5-contract-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    credentialsPath,
    `[default]\napi_url = https://api.testsprite.com\napi_key = sk-user-test\n`,
    { mode: 0o600 },
  );
  return { credentialsPath };
}

describe('P5 schema contract — runFailureGet returns a §6.7 FailureContext', () => {
  it('runFailureGet returns the wire envelope for a known failing test', async () => {
    const { credentialsPath } = makeCreds();
    const result = await runFailureGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: FIXTURE_TEST_ID_FAILED,
        failedOnly: false,
      },
      { credentialsPath, stdout: () => undefined },
    );
    validateFailureContext(result.context);
    expect(result.context.testId).toBe(FIXTURE_TEST_ID_FAILED);
    expect(result.bundle).toBeUndefined();
  });

  it('runFailureGet returns a §6.7 FailureContext for the no-analysis branch', async () => {
    const { credentialsPath } = makeCreds();
    const result = await runFailureGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: FIXTURE_TEST_ID_NO_ANALYSIS,
        failedOnly: false,
      },
      { credentialsPath, stdout: () => undefined },
    );
    validateFailureContext(result.context);
    expect(result.context.failure.rootCauseHypothesis).toBeNull();
    expect(result.context.failure.evidence).toEqual([]);
  });
});
