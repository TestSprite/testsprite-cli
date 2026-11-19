import { describe, expect, it } from 'vitest';
import {
  buildDryRunPathPattern,
  DRY_RUN_SAMPLE_ENTRIES,
  findSample,
  sampleJUnitReportXml,
} from './samples.js';
import * as v from 'valibot';
import { RESULT_DETAIL_SCHEMA, RESULT_LIST_SCHEMA } from '../response-schemas.js';

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

describe('findSample skipDependencies echo', () => {
  it.each(['/tests/test_a/runs', '/tests/batch/run'])(
    'POST %s echoes skipDependencies only when the request carried it',
    path => {
      const echoed = findSample('POST', path, { skipDependencies: true })!.body() as Record<
        string,
        unknown
      >;
      expect(echoed.skipDependencies).toBe(true);
      const plain = findSample('POST', path, { source: 'cli' })!.body() as Record<string, unknown>;
      expect('skipDependencies' in plain).toBe(false);
      const none = findSample('POST', path)!.body() as Record<string, unknown>;
      expect('skipDependencies' in none).toBe(false);
    },
  );
});

describe('findSample', () => {
  it('keeps tunnel collection and single-client samples distinct', () => {
    const list = findSample('GET', '/tunnel');
    const status = findSample('GET', '/tunnel/11111111-2222-4333-8444-555555555555');
    expect(list?.operationId).toBe('listTunnels');
    expect(list?.body()).toMatchObject({ tunnels: [{ status: 'online' }, { status: 'offline' }] });
    expect(status?.operationId).toBe('getTunnelStatus');
    expect(status?.body()).toMatchObject({ status: 'online' });
  });
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

  // `result list` / `result get` read results now; no command calls these.
  it.each([
    '/tests/t_x/code',
    '/schedules/sch_1/runs',
    '/tests/t_x/steps',
    '/tests/t_x/result',
    '/tests/t_x/failure',
    '/tests/t_x/failure/summary',
    '/tests/t_x/runs',
    '/runs/run_x/failure',
  ])('GET %s has no sample', path => {
    expect(findSample('GET', `https://api.testsprite.com/api/cli/v1${path}`)).toBeUndefined();
  });

  it('resolves /tests/executions/{id}/report without the /tests/{testId} family catching it', () => {
    const report = findSample(
      'GET',
      'https://api.testsprite.com/api/cli/v1/tests/executions/exec_1/report',
    );
    expect(report?.operationId).toBe('getExecutionReport');
    // Four segments never match the two-segment `getTest` pattern either way.
    expect(
      findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests/executions')?.operationId,
    ).toBe('getTest');
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
          expect(body).toMatchObject({ items: expect.any(Array), nextToken: null });
          break;
        case 'getProject':
          expect(body).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            instruction: expect.any(String),
          });
          break;
        case 'getTest':
          // The case alone: title, not name; priority present (string or null).
          expect(body).toMatchObject({ id: expect.any(String), title: expect.any(String) });
          expect('priority' in body).toBe(true);
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
            resultId: expect.any(String),
            testId: expect.any(String),
            projectId: expect.any(String),
            userId: expect.any(String),
            status: expect.any(String),
            stepSummary: expect.any(Object),
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
        case 'createProject':
          // P6 — POST /projects → CliCreateProjectResponse shape. Both id
          // field names present (the live field is
          // `projectId`; `id` is kept for back-compat).
          expect(body).toMatchObject({
            projectId: expect.any(String),
            id: expect.any(String),
            type: expect.any(String),
            name: expect.any(String),
            createdFrom: expect.any(String),
            createdAt: expect.any(String),
          });
          break;
        case 'updateProject':
          // P7 — PATCH /projects/{id} → CliUpdateProjectResponse shape. Both
          // id field names present.
          expect(body).toMatchObject({
            projectId: expect.any(String),
            id: expect.any(String),
            updatedFields: expect.any(Array),
            updatedAt: expect.any(String),
          });
          break;
        case 'cancelRun':
          expect(body).toMatchObject({
            runId: expect.any(String),
            alreadyCancelled: false,
            alreadyFinished: false,
            results: [
              expect.objectContaining({ resultId: expect.any(String), status: 'cancelled' }),
            ],
          });
          break;
        case 'deleteProject':
          // DELETE /projects/{id} → CliDeleteProjectResponse shape.
          expect(body).toMatchObject({
            projectId: expect.any(String),
            deletedAt: expect.any(String),
          });
          break;
        case 'listSchedules':
          expect(body).toMatchObject({ schedules: expect.any(Array) });
          break;
        case 'getSchedule':
        case 'updateSchedule':
          expect(body).toMatchObject({
            scheduleId: expect.any(String),
            name: expect.any(String),
            enabled: expect.any(Boolean),
            targetType: expect.any(String),
            cron: expect.any(String),
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          });
          break;
        case 'createSchedule':
        case 'deleteSchedule':
          expect(body).toMatchObject({ scheduleId: expect.any(String) });
          break;
        case 'listTunnels':
          expect(body).toMatchObject({ tunnels: expect.any(Array) });
          expect((body as { tunnels: unknown[] }).tunnels).toHaveLength(2);
          break;
        case 'getTunnelStatus':
          expect(body).toMatchObject({
            clientId: expect.any(String),
            status: expect.any(String),
            expiresAt: expect.any(String),
          });
          break;
        case 'getExecutionReport':
          expect(body).toMatchObject({
            ready: true,
            markdown: expect.any(String),
            report: expect.objectContaining({
              runId: expect.any(String),
              stats: expect.objectContaining({ total: expect.any(Number) }),
              tests: expect.any(Array),
            }),
          });
          break;
        case 'startConversation':
          expect(body).toMatchObject({ id: expect.any(String), url: expect.any(String) });
          break;
        case 'listConversations':
          expect(body).toMatchObject({ conversations: expect.any(Array) });
          break;
        case 'getConversation':
          expect(body).toMatchObject({
            id: expect.any(String),
            url: expect.any(String),
            state: expect.any(String),
            lastSeq: expect.any(Number),
            events: expect.any(Array),
          });
          break;
        case 'conversationFileUrl':
          expect(body).toMatchObject({ uploadUrl: expect.any(String), name: expect.any(String) });
          break;
        case 'sendConversationMessage':
        case 'sendConversationEnvironmentMessage':
          expect(body).toMatchObject({ seq: expect.any(Number) });
          break;
        case 'applyConversationProposal':
          expect(body).toMatchObject({ applied: expect.any(String), ok: true });
          break;
        case 'rejectConversationProposal':
          expect(body).toMatchObject({ rejected: expect.any(String) });
          break;
        case 'stopConversation':
          expect(body).toMatchObject({ ok: true });
          break;
        case 'discardConversation':
          expect(body).toMatchObject({
            discarded: expect.any(String),
            released: expect.any(Array),
          });
          break;
        case 'listResults':
          expect(body).toMatchObject({ results: expect.any(Array) });
          break;
        case 'getResult':
          expect(body).toMatchObject({
            resultId: expect.any(String),
            runId: expect.any(String),
            testStatus: expect.any(String),
            steps: expect.any(Array),
          });
          break;
        default:
          throw new Error(`Unexpected operationId in samples: ${e.operationId}`);
      }
    }
  });

  it('PATCH /tests/{id} has no sample (backend route is PUT)', () => {
    const e = findSample('PATCH', 'https://api.testsprite.com/api/cli/v1/tests/test_abc');
    expect(e).toBeUndefined();
  });

  // defect-2 fix: getRun sample must return the passed shape (first-match-wins
  // in findSample). Prior to fix, a duplicate failed-shape entry appeared
  // before the passed-shape entry; `run wait --dry-run` always resolved to
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

  it('GET /runs/res_failed_sample resolves to the sentinel failed run sample', () => {
    const e = findSample('GET', 'https://api.testsprite.com/api/cli/v1/runs/res_failed_sample');
    expect(e?.operationId).toBe('getRun');
    const body = e?.body() as {
      status: string;
      resultId: string;
      failedStepIndex: number | null;
      failureKind: string | null;
      error: string | null;
      stepSummary: { total: number; completed: number; passedCount: number; failedCount: number };
    };
    expect(body.resultId).toBe('res_failed_sample');
    expect(body.status).toBe('failed');
    expect(body.failedStepIndex).toBe(3);
    expect(body.failureKind).toBe('assertion');
    expect(body.error).toEqual(expect.any(String));
    expect(body.stepSummary).toMatchObject({
      total: 3,
      completed: 3,
      passedCount: 2,
      failedCount: 1,
    });
  });

  // POST /runs/{runId}/cancel must resolve to `cancelRun`, never fall
  // through to the GET-only `getRun` entry despite sharing the
  // `/runs/{runId}` path prefix — findSample filters by method first.
  it('POST /runs/{runId}/cancel resolves cancelRun (not getRun)', () => {
    const e = findSample('POST', 'https://api.testsprite.com/api/cli/v1/runs/run_xyz/cancel');
    expect(e?.operationId).toBe('cancelRun');
    const body = e?.body() as {
      results: Array<{ status: string }>;
      alreadyCancelled: boolean;
      runId: string;
    };
    expect(body.results[0]?.status).toBe('cancelled');
    expect(body.alreadyCancelled).toBe(false);
  });

  it('GET /runs/{runId}/cancel has no sample (cancel is POST-only)', () => {
    const e = findSample('GET', 'https://api.testsprite.com/api/cli/v1/runs/run_xyz/cancel');
    expect(e).toBeUndefined();
  });

  it('getTest sample carries priority field (G1a)', () => {
    const e = findSample('GET', 'https://api.testsprite.com/api/cli/v1/tests/test_abc');
    expect(e?.operationId).toBe('getTest');
    const body = e?.body() as Record<string, unknown>;
    expect('priority' in body).toBe(true);
    // First test in the sample has priority 'Medium' (reads return High/Medium/Low).
    expect(body.priority).toBe('Medium');
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

  it('POST /tests/batch/run resolves triggerBatchRunFresh', () => {
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
      resultId: expect.any(String),
      enqueuedAt: expect.any(String),
    });
  });

  it('keeps the failed run sentinel before generic getRun while retaining cancelRun', () => {
    // findSample is first-match-wins; exact run fixtures must precede
    // `/runs/{runId}` so `run wait --dry-run` still gets the passed sample.
    // The adjacent POST cancel fixture was added on main after this branch forked.
    const failedRunIndex = DRY_RUN_SAMPLE_ENTRIES.findIndex(
      e => e.method === 'GET' && e.pathTemplate === '/runs/res_failed_sample',
    );
    const genericRunIndex = DRY_RUN_SAMPLE_ENTRIES.findIndex(
      e => e.method === 'GET' && e.pathTemplate === '/runs/{runId}',
    );
    const cancelRunIndex = DRY_RUN_SAMPLE_ENTRIES.findIndex(
      e => e.method === 'POST' && e.pathTemplate === '/runs/{runId}/cancel',
    );
    expect(failedRunIndex).toBeGreaterThanOrEqual(0);
    expect(genericRunIndex).toBeGreaterThanOrEqual(0);
    expect(cancelRunIndex).toBeGreaterThanOrEqual(0);
    expect(failedRunIndex).toBeLessThan(genericRunIndex);
  });
});

describe('result samples', () => {
  const API = 'https://api.testsprite.com/api/cli/v1';

  it('GET /results resolves listResults for a run and for a test', () => {
    for (const query of ['run=exec_x&status=failed%2Cblocked', 'test=case-a&env=staging&limit=5']) {
      expect(findSample('GET', `${API}/results?${query}`)?.operationId).toBe('listResults');
    }
  });

  it('GET /results/{resultId} resolves getResult, not the listing', () => {
    expect(findSample('GET', `${API}/results/result_x`)?.operationId).toBe('getResult');
    expect(findSample('GET', `${API}/results/result_x/steps`)).toBeUndefined();
  });

  it('the listing is one run with a running, a failed, a passed and a blocked result', () => {
    const body = findSample('GET', '/results')!.body();
    const list = v.parse(RESULT_LIST_SCHEMA, body);
    // The sample spells out every field, so parsing changes nothing.
    expect(list).toEqual(body);
    const { results } = list;
    expect(results.map(r => r.testStatus).sort()).toEqual([
      'BLOCKED',
      'FAILED',
      'PASSED',
      'RUNNING',
    ]);
    expect(new Set(results.map(r => r.runId)).size).toBe(1);
  });

  it('each result belongs to a sample test: caseKey is the id `test list` prints', () => {
    // On the backend a result's `caseKey` is the test id the CLI uses, so a
    // dry run of `result list --test <id>` must line up with `test list`.
    const tests = findSample('GET', '/tests')!.body() as { items: Array<{ id: string }> };
    const ids = tests.items.map(test => test.id);
    const { results } = findSample('GET', '/results')!.body() as {
      results: Array<{ caseKey: string }>;
    };
    expect(results.map(r => r.caseKey).every(caseKey => ids.includes(caseKey))).toBe(true);
    expect(new Set(results.map(r => r.caseKey)).size).toBe(results.length);
    const detail = findSample('GET', '/results/any')!.body() as { caseKey: string };
    expect(ids).toContain(detail.caseKey);
  });

  it('a result names its test as `test list` does, and the report rows name theirs the same way', () => {
    const tests = findSample('GET', '/tests')!.body() as {
      items: Array<{ id: string; title: string }>;
    };
    const nameOf = new Map(tests.items.map(test => [test.id, test.title]));
    const { results } = findSample('GET', '/results')!.body() as {
      results: Array<{ resultId: string; caseKey: string; title: string }>;
    };
    expect(results.map(r => r.title)).toEqual(results.map(r => nameOf.get(r.caseKey)));
    const detail = findSample('GET', '/results/any')!.body() as { caseKey: string; title: string };
    expect(detail.title).toBe(nameOf.get(detail.caseKey));
    const { report } = findSample('GET', '/tests/executions/e/report')!.body() as {
      report: { tests: Array<{ id: string; title: string }> };
    };
    const titleOf = new Map(results.map(r => [r.resultId, r.title]));
    expect(report.tests.map(t => t.title)).toEqual(report.tests.map(t => titleOf.get(t.id)));
  });

  it("the history window is a test's: a run's listing carries neither field", () => {
    const run = findSample('GET', `${API}/results?run=r1&status=failed`)!.body() as object;
    expect(run).toHaveProperty('results');
    expect(run).not.toHaveProperty('hiddenRunCount');
    expect(run).not.toHaveProperty('retentionDays');
    const test = findSample('GET', `${API}/results?test=t1`)!.body() as object;
    expect(test).toMatchObject({ hiddenRunCount: 4, retentionDays: 30 });
  });

  it("the listing says how much of a test's history the plan holds back", () => {
    const list = findSample('GET', '/results')!.body() as {
      hiddenRunCount?: number;
      retentionDays?: number | null;
    };
    expect(list.hiddenRunCount).toBeGreaterThan(0);
    expect(list.retentionDays).toBeGreaterThan(0);
  });

  it('the single result is the failed one of that listing, with its failed step', () => {
    const list = findSample('GET', '/results')!.body() as { results: Array<{ resultId: string }> };
    const body = findSample('GET', '/results/any')!.body();
    const detail = v.parse(RESULT_DETAIL_SCHEMA, body);
    expect(detail).toEqual(body);
    expect(detail.testStatus).toBe('FAILED');
    expect(list.results.map(r => r.resultId)).toContain(detail.resultId);
    expect(detail.failedStep).toEqual(detail.steps.find(s => s.status === 'failed'));
    expect(detail.failedStep).not.toBeNull();
    // A frontend test: the backend sends its traceback and output as null.
    expect(detail).toMatchObject({ trace: null, apiOutput: null });
    // Values the backend sends: its TEST_TYPE (upper case) and a STEP_ACTION
    // assertion, so a script learnt from --dry-run matches a real response.
    expect(detail.type).toBe('FRONTEND');
    expect(detail.failedStep).toMatchObject({ type: 'assertion', action: 'visible' });
  });
});

describe('schedule samples', () => {
  it('resolves every schedule route and matches real base schedule shape', () => {
    expect(findSample('GET', '/schedules')?.operationId).toBe('listSchedules');
    expect(findSample('POST', '/schedules')?.operationId).toBe('createSchedule');
    const getSample = findSample('GET', '/schedules/sch_1');
    expect(getSample?.operationId).toBe('getSchedule');
    const getBody = getSample?.body() as { environment?: unknown; environmentMode?: unknown };
    expect(getBody.environment).toBeNull();
    expect(getBody.environmentMode).toBe('inherit');
    expect(findSample('PATCH', '/schedules/sch_1')?.operationId).toBe('updateSchedule');
    expect(findSample('DELETE', '/schedules/sch_1')?.operationId).toBe('deleteSchedule');
  });

  it('wraps the schedule list body in its named key', () => {
    const list = findSample('GET', '/schedules')?.body() as { schedules?: unknown[] };
    expect(Array.isArray(list.schedules)).toBe(true);
  });

  it('echoes the update patch so a caller can confirm their flags landed', () => {
    // The request body goes to `findSample`, not to `body()` — the returned
    // entry's `body` is a zero-arity closure over it.
    const body = findSample('PATCH', '/schedules/sch_1', {
      enabled: false,
      name: 'Renamed',
    })?.body() as { enabled?: boolean; name?: string };
    expect(body.enabled).toBe(false);
    expect(body.name).toBe('Renamed');
  });

  it('echoes environment, startAt and endAt in updateSchedule sample using ISO strings', () => {
    const body = findSample('PATCH', '/schedules/sch_1', {
      environment: 'staging',
      startAt: '2027-01-01',
      endAt: '2027-06-01',
    })?.body() as {
      environment?: string;
      environmentMode?: string;
      startAt?: string;
      endAt?: string | null;
    };
    expect(body.environment).toBe('staging');
    expect(body.environmentMode).toBe('pinned');
    expect(body.startAt).toBe(new Date('2027-01-01').toISOString());
    expect(body.endAt).toBe(new Date('2027-06-01').toISOString());
  });

  it('leaves fields the patch did not mention at their sample values', () => {
    const body = findSample('PATCH', '/schedules/sch_1', { enabled: false })?.body() as {
      name?: string;
      cron?: string;
    };
    expect(body.name).toBe('Nightly checkout');
    expect(body.cron).toBe('0 3 * * *');
  });
});

describe('buildDryRunPathPattern (route-template regex escaping)', () => {
  it('matches a literal dot, not "any character"', () => {
    const pattern = buildDryRunPathPattern('/files/{name}.txt');
    expect(pattern.test('/files/report.txt')).toBe(true);
    // A wildcard dot would also accept this; a literal dot must not.
    expect(pattern.test('/files/reportXtxt')).toBe(false);
  });

  it('matches literal parentheses, not a non-capturing group', () => {
    const pattern = buildDryRunPathPattern('/(group)/{id}');
    expect(pattern.test('/(group)/123')).toBe(true);
    // Unescaped parens are pure grouping syntax with no literal-character
    // meaning, so a builder that forgot to escape them would require the
    // parens to be ABSENT from the URL instead of present.
    expect(pattern.test('/group/123')).toBe(false);
  });

  it('matches a literal backslash + letter + plus, not a regex shorthand class', () => {
    // Read as a regex fragment, an unescaped `\d+` means "one or more
    // digits". The template's backslash, "d" and "+" must instead be
    // required as four literal characters wherever they sit in the path.
    const pattern = buildDryRunPathPattern('/pattern\\d+/{id}');
    expect(pattern.test('/pattern\\d+/anything')).toBe(true);
    expect(pattern.test('/pattern123/anything')).toBe(false);
  });

  it('still resolves every registered route exactly as before the escaping fix', () => {
    // None of the registry's real templates contain regex metacharacters
    // today, so escaping them is a no-op for the existing catalog: every
    // entry's pattern must still match a path built from its own template.
    for (const e of DRY_RUN_SAMPLE_ENTRIES) {
      const samplePath = e.pathTemplate.replace(/\{[^}]+\}/g, 'sample_value');
      expect(e.pattern.test(samplePath)).toBe(true);
    }
  });
});

describe('findSample agent conversation routes', () => {
  it.each([
    ['POST', '/projects/p_x/conversations', 'startConversation'],
    ['GET', '/projects/p_x/conversations?limit=1', 'listConversations'],
    ['GET', '/projects/p_x/conversations/c_1?afterSeq=0&waitSeconds=25', 'getConversation'],
    ['POST', '/projects/p_x/conversations/c_1/files', 'conversationFileUrl'],
    ['POST', '/projects/p_x/conversations/c_1/messages', 'sendConversationMessage'],
    ['POST', '/projects/p_x/conversations/c_1/apply', 'applyConversationProposal'],
    ['POST', '/projects/p_x/conversations/c_1/reject', 'rejectConversationProposal'],
    ['POST', '/projects/p_x/conversations/c_1/stop', 'stopConversation'],
    ['POST', '/projects/p_x/conversations/c_1/discard', 'discardConversation'],
  ] as const)('%s %s → %s', (method, path, operationId) => {
    expect(findSample(method, path)?.operationId).toBe(operationId);
  });

  it('never shows a live-looking portal link', () => {
    const sample = findSample('GET', '/projects/p_x/conversations/c_1')!.body() as { url: string };
    expect(sample.url).toContain('.invalid/');
  });
});
