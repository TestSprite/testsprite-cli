import { describe, expect, it } from 'vitest';
import { DRY_RUN_SAMPLE_ENTRIES, findSample, sampleJUnitReportXml } from './samples.js';

describe('sampleJUnitReportXml', () => {
  it('returns well-formed JUnit XML with canned batch ids', () => {
    const xml = sampleJUnitReportXml('proj_dry');
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<testsuite name="testsprite:proj_dry"');
    expect(xml).toContain('classname="proj_dry"');
    expect(xml).toContain('name="test_fresh_wave_01"');
    expect(xml).toContain('name="test_fresh_wave_02"');
    expect(xml).toContain('failures="1"');
  });

  it('honors reportSuiteName override', () => {
    const xml = sampleJUnitReportXml('proj_dry', 'custom-ci-suite');
    expect(xml).toContain('<testsuite name="custom-ci-suite"');
    expect(xml).not.toContain('testsprite:proj_dry');
  });
});

describe('findSample', () => {
  it('resolves /me', () => {
    const e = findSample('GET', 'https://api.testsprite.com/api/cli/v1/me');
    expect(e?.operationId).toBe('whoami');
    expect((e?.body() as { userId: string }).userId).toBeTruthy();
  });

  it('resolves /projects (list)', () => {
    const e = findSample('GET', 'https://api.testsprite.com/api/cli/v1/projects');
    expect(e?.operationId).toBe('listProjects');
    const body = e?.body() as { items: unknown[]; nextToken: null };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.nextToken).toBeNull();
  });

  it('resolves /projects/{id}', () => {
    const e = findSample('GET', 'https://api.testsprite.com/api/cli/v1/projects/proj_anything');
    expect(e?.operationId).toBe('getProject');
  });

  it('resolves /tests (list) — must not collide with /tests/{id}', () => {
    const list = findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests');
    expect(list?.operationId).toBe('listTests');
    const detail = findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests/test_anything');
    expect(detail?.operationId).toBe('getTest');
  });

  it('resolves nested /tests/{id}/{code,steps,result,failure}', () => {
    const code = findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests/t_x/code');
    expect(code?.operationId).toBe('getTestCode');
    const steps = findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests/t_x/steps');
    expect(steps?.operationId).toBe('listTestSteps');
    const result = findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests/t_x/result');
    expect(result?.operationId).toBe('getTestResult');
    const failure = findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests/t_x/failure');
    expect(failure?.operationId).toBe('getTestFailure');
  });

  it('resolves /tests/{id}/failure/summary distinct from /failure (M2.1 piece 3)', () => {
    // The summary endpoint must match BEFORE the bundle endpoint so a
    // dry-run user practising `failure summary` doesn't get the bundle
    // shape back. Pattern order is significant inside the entry list.
    const summary = findSample(
      'GET',
      'https://api.testsprite.com/api/cli/v1/tests/t_x/failure/summary',
    );
    expect(summary?.operationId).toBe('getTestFailureSummary');
    const bundle = findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests/t_x/failure');
    expect(bundle?.operationId).toBe('getTestFailure');
  });

  it('ignores query string when matching', () => {
    const a = findSample('GET', 'https://api.testsprite.com/api/cli/v1/projects?pageSize=2');
    const b = findSample('GET', 'https://api.testsprite.com/api/cli/v1/projects');
    expect(a?.operationId).toBe(b?.operationId);
  });

  it('returns undefined for unknown paths', () => {
    expect(findSample('GET', 'https://api.testsprite.com/api/cli/v1/nope')).toBeUndefined();
  });

  it('returns undefined for unsupported methods (no matching sample)', () => {
    // DELETE /projects is not registered — should be undefined.
    const del = findSample('DELETE', 'https://api.testsprite.com/api/cli/v1/projects');
    expect(del).toBeUndefined();
  });

  it('handles paths without the facade prefix (defensive)', () => {
    // Some test setups may strip the facade prefix before calling fetch.
    const e = findSample('GET', '/projects');
    expect(e?.operationId).toBe('listProjects');
  });

  it('every entry has a body matching the §6.x non-null required fields', () => {
    for (const e of DRY_RUN_SAMPLE_ENTRIES) {
      const body = e.body() as Record<string, unknown>;
      switch (e.operationId) {
        case 'whoami':
          expect(body).toMatchObject({
            userId: expect.any(String),
            keyId: expect.any(String),
            scopes: expect.any(Array),
            env: expect.any(String),
          });
          break;
        case 'listProjects':
        case 'listTests':
        case 'listTestSteps':
          expect(body).toMatchObject({ items: expect.any(Array), nextToken: null });
          break;
        case 'getProject':
          expect(body).toMatchObject({ id: expect.any(String), name: expect.any(String) });
          break;
        case 'getTest':
          // G1a — priority must be present (truthy string or null).
          expect(body).toMatchObject({ id: expect.any(String), name: expect.any(String) });
          expect('priority' in body).toBe(true);
          break;
        case 'getTestCode':
          expect(body).toMatchObject({
            testId: expect.any(String),
            language: expect.any(String),
            code: expect.any(String),
          });
          break;
        case 'getTestResult':
          // verdict (outcome) + executionStatus (lifecycle) + semantic
          // summary string, alongside the retained legacy `status`.
          expect(body).toMatchObject({
            testId: expect.any(String),
            status: expect.any(String),
            verdict: expect.any(String),
            executionStatus: expect.any(String),
            snapshotId: expect.any(String),
            summary: expect.any(String),
            targetUrlSource: 'run',
          });
          break;
        case 'getTestFailure':
          expect(body).toMatchObject({
            snapshotId: expect.any(String),
            testId: expect.any(String),
            projectId: expect.any(String),
            result: expect.any(Object),
            steps: expect.any(Array),
            code: expect.any(Object),
            failure: expect.any(Object),
          });
          break;
        case 'getTestFailureSummary':
          // §5.2 / M2.1 piece 3 — flat shape, no bundle metadata.
          expect(body).toMatchObject({
            testId: expect.any(String),
            status: expect.any(String),
            snapshotId: expect.any(String),
          });
          break;
        case 'createTestFromCode':
          // M3.2 piece-2 — `CreateTestResponse` echoed from a POST.
          // Piece-5 reuses the same sample for `--plan-from`; the
          // sampler doesn't body-inspect, so the same body covers both.
          expect(body).toMatchObject({
            testId: expect.any(String),
            type: expect.any(String),
            codeVersion: expect.any(String),
            createdAt: expect.any(String),
          });
          break;
        case 'putPlanSteps':
          // M3.2 piece-6 — `PutPlanStepsResponse` echoed from a PUT.
          // FE-only; BE tests get a 400 from the server.
          expect(body).toMatchObject({
            testId: expect.any(String),
            planStepsHash: expect.any(String),
            stepCount: expect.any(Number),
            updatedAt: expect.any(String),
          });
          break;
        case 'putTestCode':
          // M3.2 piece-4 — `PutTestCodeResponse` echoed from a PUT.
          // The bumped codeVersion drives the next call's If-Match.
          expect(body).toMatchObject({
            testId: expect.any(String),
            codeVersion: expect.any(String),
            updatedAt: expect.any(String),
          });
          break;
        case 'updateTest':
          // M3.2 piece-3 — `UpdateTestResponse` echoed from a PUT.
          expect(body).toMatchObject({
            testId: expect.any(String),
            updatedFields: expect.any(Array),
            updatedAt: expect.any(String),
          });
          break;
        case 'deleteTest':
          // M3.2 piece-3 — `DeleteTestResponse` echoed from a DELETE
          // (permanent hard-delete; no restore window).
          expect(body).toMatchObject({
            testId: expect.any(String),
            deletedAt: expect.any(String),
          });
          break;
        case 'deleteBatch':
          // delete-batch dispatches DELETE /tests/{testId} per test (no batch
          // endpoint). The canned sample shows CliBulkDeleteSummary shape with
          // a mix of deleted + skipped results.
          expect(body).toMatchObject({
            results: expect.any(Array),
            summary: expect.objectContaining({
              total: expect.any(Number),
              deleted: expect.any(Number),
              skipped: expect.any(Number),
              failed: expect.any(Number),
            }),
          });
          break;
        case 'createTestBatch':
          // M3.2 piece-5 — batch create response (FE-only). Per-spec
          // results preserve input order; mixed-status sample shows
          // 2 created + 1 validation_error.
          expect(body).toMatchObject({
            results: expect.any(Array),
            summary: expect.objectContaining({
              total: expect.any(Number),
              created: expect.any(Number),
              failed: expect.any(Number),
            }),
          });
          break;
        case 'triggerRun':
          // M3.3 piece-3 — POST /tests/{testId}/runs → TriggerRunResponse.
          expect(body).toMatchObject({
            runId: expect.any(String),
            status: 'queued',
            enqueuedAt: expect.any(String),
            codeVersion: expect.any(String),
            targetUrl: expect.any(String),
          });
          break;
        case 'getRun':
          // M3.3 piece-3 — GET /runs/{runId} → RunResponse.
          expect(body).toMatchObject({
            runId: expect.any(String),
            testId: expect.any(String),
            projectId: expect.any(String),
            userId: expect.any(String),
            status: expect.any(String),
            stepSummary: expect.any(Object),
          });
          break;
        case 'getRunFailure':
          // M3.3 piece-4 — run-scoped failure bundle (same FailureContext
          // shape as `getTestFailure` but addressed by runId).
          expect(body).toMatchObject({
            snapshotId: expect.any(String),
            testId: expect.any(String),
            result: expect.objectContaining({ snapshotId: expect.any(String) }),
          });
          break;
        case 'triggerRerun':
          // M3.4 piece-3 — POST /tests/{testId}/runs/rerun → RerunResponse.
          // G1c — closure is ALWAYS present (null for FE, object for BE).
          expect(body).toMatchObject({
            runId: expect.any(String),
            status: 'queued',
            enqueuedAt: expect.any(String),
            codeVersion: expect.any(String),
            autoHeal: expect.any(Boolean),
          });
          // closure must be explicitly present (not undefined); may be object or null.
          expect('closure' in body).toBe(true);
          break;
        case 'triggerBatchRerun':
          // M3.4 piece-3 — POST /tests/batch/rerun → BatchRerunResponse.
          expect(body).toMatchObject({
            accepted: expect.any(Array),
            deferred: expect.any(Array),
            conflicts: expect.any(Array),
            closure: expect.any(Object),
          });
          break;
        case 'triggerBatchRunFresh':
          // M4 piece-2 — POST /tests/batch/run → BatchRunFreshResponse.
          expect(body).toMatchObject({
            accepted: expect.any(Array),
            skippedFrontend: expect.any(Array),
          });
          // Each accepted entry must carry testId + enqueuedAt.
          // runId may be undefined for draft tests but the dry-run sample provides it.
          expect(
            (body as { accepted: Array<Record<string, unknown>> }).accepted.length,
          ).toBeGreaterThan(0);
          break;
        case 'listTestRuns': {
          // M3.4 piece-5 — GET /tests/{testId}/runs → ListRunsResponse.
          // G1b — run rows include targetUrl + targetUrlSource fields.
          expect(body).toMatchObject({
            runs: expect.any(Array),
            nextCursor: null,
            meta: expect.any(Object),
          });
          // At least one run row present for illustrative purposes.
          const runs = (body as { runs: Array<Record<string, unknown>> }).runs;
          expect(runs.length).toBeGreaterThan(0);
          // All rows must carry the G1b fields (present, even if null).
          for (const row of runs) {
            expect('targetUrl' in row).toBe(true);
            expect('targetUrlSource' in row).toBe(true);
          }
          // First row: a real URL with source='run'.
          expect(runs[0]).toMatchObject({ targetUrl: expect.any(String), targetUrlSource: 'run' });
          // Second row: unresolved shape (null URL, source='unresolved').
          expect(runs[1]).toMatchObject({ targetUrl: null, targetUrlSource: 'unresolved' });
          break;
        }
        case 'createProject':
          // P6 — POST /projects → CliProject shape.
          expect(body).toMatchObject({
            id: expect.any(String),
            type: expect.any(String),
            name: expect.any(String),
            createdFrom: expect.any(String),
            createdAt: expect.any(String),
          });
          break;
        case 'updateProject':
          // P7 — PATCH /projects/{id} → CliUpdateProjectResponse shape.
          expect(body).toMatchObject({
            id: expect.any(String),
            updatedFields: expect.any(Array),
            updatedAt: expect.any(String),
          });
          break;
        default:
          throw new Error(`Unexpected operationId in samples: ${e.operationId}`);
      }
    }
  });

  it('GET /tests/{testId}/runs resolves listTestRuns (not getTest)', () => {
    const e = findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests/test_abc/runs');
    expect(e?.operationId).toBe('listTestRuns');
    const body = e?.body() as {
      runs: Array<Record<string, unknown>>;
      nextCursor: null;
      meta: unknown;
    };
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBeGreaterThan(0);
    expect(body.nextCursor).toBeNull();
    // G1b — every row must carry targetUrl + targetUrlSource.
    for (const row of body.runs) {
      expect('targetUrl' in row).toBe(true);
      expect('targetUrlSource' in row).toBe(true);
    }
  });

  it('GET /tests/{testId}/runs: first row has isRerun:false, second has isRerun:true', () => {
    const e = findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests/test_abc/runs');
    const body = e?.body() as {
      runs: Array<{
        runId: string;
        isRerun: boolean;
        failureKind: string | null;
        targetUrl: string | null;
        targetUrlSource: string | null;
      }>;
    };
    expect(body.runs[0]?.isRerun).toBe(false);
    expect(body.runs[0]?.failureKind).toBeNull();
    // G1b — first row: real URL with source='run'.
    expect(body.runs[0]?.targetUrlSource).toBe('run');
    expect(typeof body.runs[0]?.targetUrl).toBe('string');
    expect(body.runs[1]?.isRerun).toBe(true);
    expect(body.runs[1]?.failureKind).toBe('assertion');
    // G1b — second row: unresolved shape.
    expect(body.runs[1]?.targetUrl).toBeNull();
    expect(body.runs[1]?.targetUrlSource).toBe('unresolved');
  });

  it('failure context maintains §6.7 atomicity invariant (snapshotId === result.snapshotId)', () => {
    const failure = findSample('GET', '/tests/t_x/failure');
    const body = failure?.body() as { snapshotId: string; result: { snapshotId: string } };
    expect(body.result.snapshotId).toBe(body.snapshotId);
  });

  // updateTest method regression guard.
  // Backend route is `@Put('/:testId')` in cli-tests.controller.ts:577;
  // the CLI `runUpdate` calls `client.put()`; the dry-run sample is also
  // registered as PUT. Prior audit incorrectly claimed PATCH was the wire
  // verb based on CLAUDE.md's aspirational table — actual wire reality is
  // PUT. This test pins the verb so a future "fix" doesn't silently break
  // `test update` against the deployed backend.
  it('PUT /tests/{id} resolves updateTest', () => {
    const e = findSample('PUT', 'https://api.testsprite.com/api/cli/v1/tests/test_abc');
    expect(e?.operationId).toBe('updateTest');
    const body = e?.body() as { testId: string; updatedFields: string[]; updatedAt: string };
    expect(body.testId).toBeTruthy();
    expect(Array.isArray(body.updatedFields)).toBe(true);
    expect(body.updatedAt).toBeTruthy();
  });

  it('PATCH /tests/{id} has no sample (backend route is PUT)', () => {
    const e = findSample('PATCH', 'https://api.testsprite.com/api/cli/v1/tests/test_abc');
    expect(e).toBeUndefined();
  });

  // defect-2 fix: getRun sample must return the passed shape (first-match-wins
  // in findSample). Prior to fix, a duplicate failed-shape entry appeared
  // before the passed-shape entry; `test wait --dry-run` always resolved to
  // status: "failed", giving agents the wrong happy-path canned response.
  it('GET /runs/{runId} resolves to the passed-shape getRun (not the failed shape)', () => {
    const e = findSample('GET', 'https://api.testsprite.com/api/cli/v1/runs/run_xyz');
    expect(e?.operationId).toBe('getRun');
    const body = e?.body() as {
      status: string;
      runId: string;
      stepSummary: { failedCount: number };
    };
    expect(body.status).toBe('passed');
    expect(body.stepSummary.failedCount).toBe(0);
  });

  it('getTest sample carries priority field (G1a)', () => {
    const e = findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests/test_abc');
    expect(e?.operationId).toBe('getTest');
    const body = e?.body() as Record<string, unknown>;
    expect('priority' in body).toBe(true);
    // First test in the sample has priority 'p1'.
    expect(body.priority).toBe('p1');
  });

  it('listTests sample items carry priority field (G1a)', () => {
    const e = findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests');
    expect(e?.operationId).toBe('listTests');
    const body = e?.body() as { items: Array<Record<string, unknown>> };
    expect(body.items.length).toBeGreaterThan(0);
    // Every item in the list must carry the priority field.
    for (const item of body.items) {
      expect('priority' in item).toBe(true);
    }
    // At least one item has a truthy priority to exercise the render branch.
    const hasTruthy = body.items.some(item => item.priority != null);
    expect(hasTruthy).toBe(true);
  });

  it('triggerRerun sample closure is explicitly present (G1c — always-present nullable)', () => {
    const e = findSample('POST', 'https://api.testsprite.com/api/cli/v1/tests/be_test/runs/rerun');
    const body = e?.body() as Record<string, unknown>;
    // closure must be present (not undefined); BE sample carries the object.
    expect('closure' in body).toBe(true);
    expect(body.closure).not.toBeUndefined();
  });

  it('POST /tests/{testId}/runs/rerun resolves triggerRerun (not triggerRun)', () => {
    const e = findSample('POST', 'https://api.testsprite.com/api/cli/v1/tests/test_abc/runs/rerun');
    expect(e?.operationId).toBe('triggerRerun');
    const body = e?.body() as { runId: string; status: string; autoHeal: boolean };
    expect(body.runId).toBeTruthy();
    expect(body.status).toBe('queued');
    expect(typeof body.autoHeal).toBe('boolean');
  });

  it('POST /tests/batch/rerun resolves triggerBatchRerun (not createTestBatch)', () => {
    const e = findSample('POST', 'https://api.testsprite.com/api/cli/v1/tests/batch/rerun');
    expect(e?.operationId).toBe('triggerBatchRerun');
    const body = e?.body() as { accepted: unknown[]; deferred: unknown[] };
    expect(Array.isArray(body.accepted)).toBe(true);
    expect(Array.isArray(body.deferred)).toBe(true);
  });

  it('POST /tests/batch/run resolves triggerBatchRunFresh (not rerun or create)', () => {
    const e = findSample('POST', 'https://api.testsprite.com/api/cli/v1/tests/batch/run');
    expect(e?.operationId).toBe('triggerBatchRunFresh');
    const body = e?.body() as { accepted: unknown[]; skippedFrontend: unknown[] };
    expect(Array.isArray(body.accepted)).toBe(true);
    expect(Array.isArray(body.skippedFrontend)).toBe(true);
    expect(body.accepted.length).toBeGreaterThan(0);
  });

  it('triggerBatchRunFresh sample accepted entries carry testId, runId, enqueuedAt', () => {
    const e = findSample('POST', 'https://api.testsprite.com/api/cli/v1/tests/batch/run');
    const body = e?.body() as {
      accepted: Array<{ testId: string; runId: string; enqueuedAt: string }>;
    };
    expect(body.accepted[0]).toMatchObject({
      testId: expect.any(String),
      runId: expect.any(String),
      enqueuedAt: expect.any(String),
    });
  });

  it('triggerRerun sample carries closure.members with per-member runIds (C2)', () => {
    const e = findSample('POST', 'https://api.testsprite.com/api/cli/v1/tests/be_test/runs/rerun');
    const body = e?.body() as {
      closure?: { members: Array<{ testId: string; runId: string; role: string }> };
    };
    expect(body.closure?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: expect.any(String), role: expect.any(String) }),
      ]),
    );
  });

  it('triggerBatchRerun sample carries deferred[] example (C1)', () => {
    const e = findSample('POST', 'https://api.testsprite.com/api/cli/v1/tests/batch/rerun');
    const body = e?.body() as { deferred: Array<{ testId: string; reason: string }> };
    expect(body.deferred.length).toBeGreaterThan(0);
    expect(body.deferred[0]).toMatchObject({
      testId: expect.any(String),
      reason: expect.any(String),
    });
  });

  it('DELETE /tests/batch resolves deleteBatch documentation sample', () => {
    // delete-batch is inline-dry-run (no network call) but the sample is
    // registered for shape documentation and build-guard purposes.
    const e = findSample('DELETE', 'https://api.testsprite.com/api/cli/v1/tests/batch');
    expect(e?.operationId).toBe('deleteBatch');
    const body = e?.body() as { results: unknown[]; summary: Record<string, number> };
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.summary.total).toBeGreaterThanOrEqual(1);
  });

  it('only one getRun entry exists in the registry (no duplicate)', () => {
    // Guards against re-introducing the duplicate by ensuring exactly one
    // sample is registered for GET /runs/{runId}.
    const matches = DRY_RUN_SAMPLE_ENTRIES.filter(
      e => e.method === 'GET' && e.operationId === 'getRun',
    );
    expect(matches).toHaveLength(1);
  });

  // Input-derived sample tests (Fix #1 — dogfood 2026-05-15)
  describe('input-derived samples echo user flags', () => {
    it('updateTest: updatedFields reflects the actual request body keys', () => {
      const e = findSample('PUT', 'https://api.testsprite.com/api/cli/v1/tests/test_abc', {
        name: 'my-new-name',
      });
      const body = e?.body() as { updatedFields: string[] };
      expect(body.updatedFields).toEqual(['name']);
    });

    it('updateTest: updatedFields reflects multiple fields', () => {
      const e = findSample('PUT', 'https://api.testsprite.com/api/cli/v1/tests/test_abc', {
        name: 'n',
        description: 'd',
        priority: 'high',
      });
      const body = e?.body() as { updatedFields: string[] };
      expect(body.updatedFields).toEqual(['name', 'description', 'priority']);
    });

    it('updateTest: falls back to default ["name","description"] when no request body', () => {
      const e = findSample('PUT', 'https://api.testsprite.com/api/cli/v1/tests/test_abc');
      const body = e?.body() as { updatedFields: string[] };
      expect(body.updatedFields).toEqual(['name', 'description']);
    });

    it('putPlanSteps: stepCount reflects actual planSteps array length', () => {
      const planSteps = [
        { type: 'action', description: 'step 1' },
        { type: 'assertion', description: 'step 2' },
      ];
      const e = findSample(
        'PUT',
        'https://api.testsprite.com/api/cli/v1/tests/test_abc/plan-steps',
        { planSteps },
      );
      const body = e?.body() as { stepCount: number };
      expect(body.stepCount).toBe(2);
    });

    it('putPlanSteps: falls back to stepCount 3 when no planSteps in body', () => {
      const e = findSample(
        'PUT',
        'https://api.testsprite.com/api/cli/v1/tests/test_abc/plan-steps',
      );
      const body = e?.body() as { stepCount: number };
      expect(body.stepCount).toBe(3);
    });

    it('createTestBatch: one result per supplied spec', () => {
      const tests = [
        { type: 'frontend', name: 'A' },
        { type: 'frontend', name: 'B' },
      ];
      const e = findSample('POST', 'https://api.testsprite.com/api/cli/v1/tests/batch', { tests });
      const body = e?.body() as {
        results: Array<{ specIndex: number; status: string }>;
        summary: { total: number; created: number };
      };
      expect(body.results).toHaveLength(2);
      expect(body.results[0]?.specIndex).toBe(0);
      expect(body.results[1]?.specIndex).toBe(1);
      expect(body.summary.total).toBe(2);
      expect(body.summary.created).toBe(2);
    });

    it('createTestBatch: falls back to 3-entry sample when no tests in body', () => {
      // Preserves the educational mixed-status sample for learners who run
      // dry-run without a body (e.g. direct fetch calls in tests).
      const e = findSample('POST', 'https://api.testsprite.com/api/cli/v1/tests/batch');
      const body = e?.body() as { summary: { total: number; created: number; failed: number } };
      expect(body.summary.total).toBe(3);
      expect(body.summary.created).toBe(2);
      expect(body.summary.failed).toBe(1);
    });

    it('createTestBatch: backend specs are echoed as validation_error (mirroring runCreateBatch)', () => {
      // codex-review round-2 P2 (2026-05-28): the round-1 fix added a
      // type === 'backend' branch but had no regression guard. This test
      // covers the rejection path so a future refactor can't silently
      // start marking BE specs as `created` again.
      const tests = [
        { type: 'frontend', name: 'fe-spec' },
        { type: 'backend', name: 'be-spec' },
        { type: 'frontend', name: 'another-fe' },
      ];
      const e = findSample('POST', 'https://api.testsprite.com/api/cli/v1/tests/batch', { tests });
      const body = e?.body() as {
        results: Array<{
          specIndex: number;
          status: string;
          testId: string | null;
          error?: { code: string; message: string; field: string };
        }>;
        summary: { total: number; created: number; failed: number };
      };
      expect(body.results).toHaveLength(3);
      // Position 0 (FE) → created
      expect(body.results[0]?.status).toBe('created');
      expect(body.results[0]?.testId).toBe('test_dryrun_batch_0');
      // Position 1 (BE) → validation_error, testId null, error wired with field=type
      expect(body.results[1]?.status).toBe('validation_error');
      expect(body.results[1]?.testId).toBeNull();
      expect(body.results[1]?.error?.code).toBe('VALIDATION_ERROR');
      expect(body.results[1]?.error?.field).toBe('type');
      // The error message should reference the BE workaround so the user
      // sees the production guidance even in dry-run.
      expect(body.results[1]?.error?.message).toMatch(/test create --type backend --code-file/);
      // Position 2 (FE) → created (BE rejection does not abort siblings)
      expect(body.results[2]?.status).toBe('created');
      // Summary counts the FE specs as created (2) and the BE spec as failed (1).
      expect(body.summary.total).toBe(3);
      expect(body.summary.created).toBe(2);
      expect(body.summary.failed).toBe(1);
    });
  });
});
