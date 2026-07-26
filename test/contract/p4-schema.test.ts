/**
 * P4 schema-contract test.
 *
 * Per the CLI validation spec §4 P4 Layer A:
 *
 *   "MSW contract test: every response from `code`, `steps`, `result`
 *    validates against the OpenAPI schema (no extra fields, no missing
 *    required fields)."
 *
 * Approach: hand-rolled strict validators that mirror
 * the CLI OpenAPI spec (TestCode §6.3, TestStep §6.4, LatestResult
 * §6.5). No `ajv` / OpenAPI runtime parser — those are heavy dev deps
 * for a contract that's already specified once in the YAML and once in
 * the CLI types. The validators here are the **third** check, and they
 * fail closed on any drift.
 *
 * The test asserts the contract holds in two places:
 *
 *   1. The MSW fixtures (what we ship as the documented "happy path").
 *   2. The CLI's runCodeGet / runSteps / runResult return values
 *      (what an agent actually sees through the CLI surface).
 *
 * If either drifts from the OpenAPI shape, this test fails before the
 * regression escapes to dev.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCodeGet, runResult, runSteps } from '../../src/commands/test.js';
import {
  failureContextFixture,
  FIXTURE_TEST_ID_FAILED,
  FIXTURE_TEST_ID_LARGE_CODE,
  FIXTURE_TEST_ID_PASSED,
  FIXTURE_TEST_ID_RUNNING,
  latestResultFailedFixture,
  latestResultPassedFixture,
  latestResultRunningFixture,
  testCodeFixture,
  testCodeLargeFixture,
  testStepsFixture,
} from '../mock-backend/fixtures.js';
import { mockBackend } from '../mock-backend/index.js';

mockBackend.installLifecycle();

const TEST_CODE_REQUIRED = ['testId', 'language', 'framework', 'code', 'codeVersion'] as const;
const TEST_CODE_OPTIONAL = ['etag'] as const;
const TEST_CODE_ALL = new Set<string>([...TEST_CODE_REQUIRED, ...TEST_CODE_OPTIONAL]);

const CODE_LANGUAGES = ['typescript', 'javascript', 'python'];
const CODE_FRAMEWORKS = ['playwright', 'pytest'];

const TEST_STEP_REQUIRED = [
  'testId',
  'stepIndex',
  'action',
  'description',
  'status',
  'screenshotUrl',
  'htmlSnapshotUrl',
  'runIdIfAvailable',
  'codeVersion',
  'capturedAt',
  'updatedAt',
] as const;
const TEST_STEP_ALL = new Set<string>(TEST_STEP_REQUIRED);

const STEP_STATUS_VALUES = new Set<unknown>(['passed', 'failed', null]);

const LATEST_RESULT_REQUIRED = [
  'testId',
  'status',
  'startedAt',
  'finishedAt',
  'videoUrl',
  'failureAnalysisUrl',
  'snapshotId',
  'runIdIfAvailable',
  'codeVersion',
  'targetUrl',
  'failedStepIndex',
  'failureKind',
  'verdict',
  'executionStatus',
  'summary',
] as const;
// `targetUrlSource` (D1) is OPTIONAL — present on backends that shipped the D1
// fix, absent on older ones — so it is in the allowed set but NOT required.
const LATEST_RESULT_ALL = new Set<string>([...LATEST_RESULT_REQUIRED, 'targetUrlSource']);
const TARGET_URL_SOURCES = new Set<unknown>(['run', 'project-default', 'unresolved', null]);

const PUBLIC_STATUSES = new Set([
  'draft',
  'ready',
  'queued',
  'running',
  'passed',
  'failed',
  'cancelled',
  'unknown',
]);
const FAILURE_KINDS = new Set<unknown>([
  'assertion',
  'timeout',
  'network',
  'browser_crash',
  'infra',
  'unknown',
  null,
]);
const VERDICTS = new Set<unknown>(['passed', 'failed', 'blocked', 'cancelled', 'unknown', null]);
const EXECUTION_STATUSES = new Set<unknown>([
  'queued',
  'running',
  'completed',
  'cancelled',
  'error',
  'unknown',
]);

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

function validateTestCode(value: unknown, label = 'TestCode'): void {
  expect(value, `${label}: must be an object`).toBeTypeOf('object');
  expect(value, `${label}: must not be null`).not.toBeNull();
  const obj = value as Record<string, unknown>;
  expectRequired(obj, TEST_CODE_REQUIRED, label);
  expectKeysMatch(obj, TEST_CODE_ALL, label);
  expect(typeof obj.testId, `${label}.testId`).toBe('string');
  expect(CODE_LANGUAGES, `${label}.language`).toContain(obj.language);
  expect(CODE_FRAMEWORKS, `${label}.framework`).toContain(obj.framework);
  expect(typeof obj.code, `${label}.code`).toBe('string');
  expectStringOrNull(obj.codeVersion, `${label}.codeVersion`);
  if ('etag' in obj) expectStringOrNull(obj.etag, `${label}.etag`);
}

function validateTestStep(value: unknown, label = 'TestStep'): void {
  expect(value, `${label}: must be an object`).toBeTypeOf('object');
  expect(value, `${label}: must not be null`).not.toBeNull();
  const obj = value as Record<string, unknown>;
  expectRequired(obj, TEST_STEP_REQUIRED, label);
  expectKeysMatch(obj, TEST_STEP_ALL, label);
  expect(typeof obj.testId, `${label}.testId`).toBe('string');
  expect(typeof obj.stepIndex, `${label}.stepIndex`).toBe('number');
  expect((obj.stepIndex as number) >= 1, `${label}.stepIndex >= 1`).toBe(true);
  expect(typeof obj.action, `${label}.action`).toBe('string');
  expect(typeof obj.description, `${label}.description`).toBe('string');
  expect(STEP_STATUS_VALUES.has(obj.status), `${label}.status`).toBe(true);
  expectStringOrNull(obj.screenshotUrl, `${label}.screenshotUrl`);
  expectStringOrNull(obj.htmlSnapshotUrl, `${label}.htmlSnapshotUrl`);
  expectStringOrNull(obj.runIdIfAvailable, `${label}.runIdIfAvailable`);
  expectStringOrNull(obj.codeVersion, `${label}.codeVersion`);
  expectStringOrNull(obj.capturedAt, `${label}.capturedAt`);
  expect(typeof obj.updatedAt, `${label}.updatedAt`).toBe('string');
}

function validateTestStepList(value: unknown, label = 'TestStepList'): void {
  expect(value, `${label}: must be an object`).toBeTypeOf('object');
  const obj = value as Record<string, unknown>;
  expectKeysMatch(obj, new Set(['items', 'nextToken']), label);
  expect(Array.isArray(obj.items), `${label}.items`).toBe(true);
  for (const [i, item] of (obj.items as unknown[]).entries()) {
    validateTestStep(item, `${label}.items[${i}]`);
  }
  if (obj.nextToken !== null) {
    expect(typeof obj.nextToken, `${label}.nextToken`).toBe('string');
  }
}

function validateLatestResult(value: unknown, label = 'LatestResult'): void {
  expect(value, `${label}: must be an object`).toBeTypeOf('object');
  expect(value, `${label}: must not be null`).not.toBeNull();
  const obj = value as Record<string, unknown>;
  expectRequired(obj, LATEST_RESULT_REQUIRED, label);
  expectKeysMatch(obj, LATEST_RESULT_ALL, label);
  expect(typeof obj.testId, `${label}.testId`).toBe('string');
  expect(PUBLIC_STATUSES, `${label}.status`).toContain(obj.status);
  expectStringOrNull(obj.startedAt, `${label}.startedAt`);
  expectStringOrNull(obj.finishedAt, `${label}.finishedAt`);
  expectStringOrNull(obj.videoUrl, `${label}.videoUrl`);
  expectStringOrNull(obj.failureAnalysisUrl, `${label}.failureAnalysisUrl`);
  expect(typeof obj.snapshotId, `${label}.snapshotId`).toBe('string');
  expectStringOrNull(obj.runIdIfAvailable, `${label}.runIdIfAvailable`);
  expectStringOrNull(obj.codeVersion, `${label}.codeVersion`);
  expectStringOrNull(obj.targetUrl, `${label}.targetUrl`);
  // D1 — optional provenance discriminator; when present must be a known enum
  // value or null (a null `targetUrl` should carry 'unresolved' or null).
  if ('targetUrlSource' in obj) {
    expect(TARGET_URL_SOURCES.has(obj.targetUrlSource), `${label}.targetUrlSource`).toBe(true);
  }
  if (obj.failedStepIndex !== null) {
    expect(typeof obj.failedStepIndex, `${label}.failedStepIndex`).toBe('number');
    expect((obj.failedStepIndex as number) >= 1, `${label}.failedStepIndex >= 1`).toBe(true);
  }
  expect(FAILURE_KINDS.has(obj.failureKind), `${label}.failureKind`).toBe(true);
  expect(VERDICTS.has(obj.verdict), `${label}.verdict`).toBe(true);
  expect(EXECUTION_STATUSES.has(obj.executionStatus), `${label}.executionStatus`).toBe(true);
  expect(typeof obj.summary, `${label}.summary`).toBe('string');
}

describe('P4 schema contract — fixtures match the OpenAPI shapes', () => {
  it('TestCode (inline) — every required field present, no extras', () => {
    validateTestCode(testCodeFixture);
  });

  it('TestCode (presigned) — same shape as inline, code is an https:// URL', () => {
    validateTestCode(testCodeLargeFixture);
    expect(testCodeLargeFixture.code.startsWith('https://')).toBe(true);
  });

  it('TestStepList — items pass per-step validation', () => {
    validateTestStepList({ items: testStepsFixture, nextToken: null });
  });

  it('LatestResult (passed)', () => {
    validateLatestResult(latestResultPassedFixture);
    expect(latestResultPassedFixture.failedStepIndex).toBeNull();
    expect(latestResultPassedFixture.failureKind).toBeNull();
  });

  it('LatestResult (failed) — failureKind + failedStepIndex are non-null', () => {
    validateLatestResult(latestResultFailedFixture);
    expect(latestResultFailedFixture.failedStepIndex).not.toBeNull();
    expect(latestResultFailedFixture.failureKind).not.toBeNull();
  });

  it('LatestResult (running) — every field present even when timing is null', () => {
    validateLatestResult(latestResultRunningFixture);
    expect(latestResultRunningFixture.finishedAt).toBeNull();
    expect(latestResultRunningFixture.videoUrl).toBeNull();
  });

  it('FailureContext.steps and code reuse the same shapes', () => {
    // Cross-check: a step embedded in a FailureContext bundle (P5) must
    // still pass the §6.4 validator. Catches the bundle drifting from
    // the standalone shapes.
    for (const [i, step] of failureContextFixture.steps.entries()) {
      validateTestStep(step, `FailureContext.steps[${i}]`);
    }
    validateTestCode(failureContextFixture.code, 'FailureContext.code');
    validateLatestResult(failureContextFixture.result, 'FailureContext.result');
  });
});

// ---- CLI surface contract: what runCodeGet/runSteps/runResult return ----
//
// These exercise the actual CLI runners against the live MSW backend so
// the assertion isn't just "the fixture is shaped right" — it's "the
// CLI's typed contract matches the wire shape." If a runner ever
// silently omits or coerces a field, this fails.

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-p4-contract-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  // The base URL must match what the MSW handlers serve (DEFAULT_BASE_URL
  // sans the /api/cli/v1 suffix that facadeBaseUrl re-appends).
  writeFileSync(
    credentialsPath,
    `[default]\napi_url = https://api.testsprite.com\napi_key = sk-test\n`,
    { mode: 0o600 },
  );
  return { credentialsPath };
}

describe('P4 schema contract — CLI runners return §6.x shapes', () => {
  it('runCodeGet (inline) returns a §6.3 TestCode', async () => {
    const { credentialsPath } = makeCreds();
    const code = await runCodeGet(
      { profile: 'default', output: 'json', debug: false, testId: FIXTURE_TEST_ID_FAILED },
      { credentialsPath, stdout: () => undefined },
    );
    validateTestCode(code);
    expect(code.code.startsWith('https://')).toBe(false);
  });

  it('runCodeGet (presigned) returns a §6.3 TestCode with https code', async () => {
    const { credentialsPath } = makeCreds();
    const code = await runCodeGet(
      { profile: 'default', output: 'json', debug: false, testId: FIXTURE_TEST_ID_LARGE_CODE },
      { credentialsPath, stdout: () => undefined },
    );
    validateTestCode(code);
    expect(code.code.startsWith('https://')).toBe(true);
  });

  it('runSteps returns a §6.4 TestStepList', async () => {
    const { credentialsPath } = makeCreds();
    const page = await runSteps(
      { profile: 'default', output: 'json', debug: false, testId: FIXTURE_TEST_ID_FAILED },
      { credentialsPath, stdout: () => undefined },
    );
    validateTestStepList(page);
  });

  it('runResult returns a §6.5 LatestResult for a failing test', async () => {
    const { credentialsPath } = makeCreds();
    const result = await runResult(
      { profile: 'default', output: 'json', debug: false, testId: FIXTURE_TEST_ID_FAILED },
      { credentialsPath, stdout: () => undefined },
    );
    validateLatestResult(result);
    expect(result.status).toBe('failed');
    expect(result.failureKind).not.toBeNull();
  });

  it('runResult returns a §6.5 LatestResult for a passing test', async () => {
    const { credentialsPath } = makeCreds();
    const result = await runResult(
      { profile: 'default', output: 'json', debug: false, testId: FIXTURE_TEST_ID_PASSED },
      { credentialsPath, stdout: () => undefined },
    );
    validateLatestResult(result);
    expect(result.status).toBe('passed');
    expect(result.failureKind).toBeNull();
  });

  it('runResult returns a §6.5 LatestResult for a running test', async () => {
    const { credentialsPath } = makeCreds();
    const result = await runResult(
      { profile: 'default', output: 'json', debug: false, testId: FIXTURE_TEST_ID_RUNNING },
      { credentialsPath, stdout: () => undefined },
    );
    validateLatestResult(result);
    expect(result.status).toBe('running');
    expect(result.finishedAt).toBeNull();
  });
});
