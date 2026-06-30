/**
 * Regression coverage for default artifact output path containment.
 */

import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CliFailureContext, resolveDefaultArtifactDir, runArtifactGet } from './test.js';

function makeCreds(): string {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-path-creds-'));
  const credentialsPath = join(dir, 'credentials');
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = http://localhost:14400\napi_key = sk-test\n',
    {
      mode: 0o600,
    },
  );
  return credentialsPath;
}

function makeContext(runId: string): CliFailureContext {
  return {
    snapshotId: 'snap_path_test',
    testId: 'test_path',
    projectId: 'project_path',
    result: {
      testId: 'test_path',
      status: 'failed',
      startedAt: null,
      finishedAt: '2026-06-30T02:40:00.000Z',
      videoUrl: null,
      failureAnalysisUrl: null,
      snapshotId: 'snap_path_test',
      runIdIfAvailable: runId,
      codeVersion: 'v1',
      targetUrl: 'https://example.com',
      failedStepIndex: null,
      failureKind: 'assertion',
      summary: { passed: 0, failed: 1, skipped: 0 },
    },
    steps: [],
    code: {
      testId: 'test_path',
      language: 'typescript',
      framework: 'playwright',
      code: 'test("path", () => {});',
      codeVersion: 'v1',
      etag: null,
    },
    failure: {
      rootCauseHypothesis: 'path test',
      recommendedFixTarget: { kind: 'unknown', reference: null, rationale: null },
      evidence: [],
    },
  };
}

describe('resolveDefaultArtifactDir', () => {
  it('keeps a normal run id under .testsprite/runs', () => {
    const cwd = join(tmpdir(), 'artifact-path');
    expect(resolveDefaultArtifactDir('run_abc123', cwd)).toBe(
      join(cwd, '.testsprite', 'runs', 'run_abc123'),
    );
  });

  it.each([
    '.',
    '..',
    '. ',
    '.. ',
    '../outside',
    '..\\outside',
    'nested/run',
    'nested\\run',
    'bad\0id',
  ])('rejects path-like run id %j', runId => {
    expect(() => resolveDefaultArtifactDir(runId, '/tmp/work')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        details: expect.objectContaining({ field: 'run-id' }),
      }),
    );
  });
});

describe('runArtifactGet default output path validation', () => {
  it('rejects unsafe default run ids before auth or fetch work', async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

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
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'run-id' }),
    });
    expect(fetchCalls).toBe(0);
  });

  it('allows path-like run ids when an explicit --out directory is provided', async () => {
    const runId = '../../outside';
    const tmp = mkdtempSync(join(tmpdir(), 'artifact-path-out-'));
    const outDir = join(tmp, 'bundle');
    mkdirSync(tmp, { recursive: true });

    const fetchImpl = (async () =>
      new Response(JSON.stringify(makeContext(runId)), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_path_test' },
      })) as typeof globalThis.fetch;

    const result = await runArtifactGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        runId,
        out: outDir,
        failedOnly: false,
      },
      { credentialsPath: makeCreds(), fetchImpl, stdout: () => {} },
    );

    expect(result.bundle?.dir).toBe(outDir);
  });
});
