import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BatchRunFreshResponse, RunResponse } from '../lib/runs.types.js';
import { runTestRunAll, renderRunResponseText, renderTestListText, type CliTest } from './test.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function makeFetch(body: unknown): typeof globalThis.fetch {
  return (async (_input: FetchInput) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;
}

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-int-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this suite's own mkdtempSync temp path, never user input
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this suite's own mkdtempSync temp path, never user input
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = http://localhost:13503\napi_key = sk-user-test\n',
    { mode: 0o600 },
  );
  return { credentialsPath };
}

const BATCH: BatchRunFreshResponse = {
  accepted: [{ testId: 't1', runId: 'r1', enqueuedAt: '2026-10-09T00:00:00.000Z' }],
  conflicts: [],
  deferred: [],
  skippedFrontend: [],
  skippedIntegration: [],
};

async function runBatch(resp: BatchRunFreshResponse): Promise<{ stderr: string; stdout: string }> {
  let stderr = '';
  let stdout = '';
  await runTestRunAll(
    {
      profile: 'default',
      output: 'json',
      debug: false,
      projectId: 'p1',
      wait: false,
      timeoutSeconds: 60,
      maxConcurrency: 5,
    },
    {
      ...makeCreds(),
      fetchImpl: makeFetch(resp),
      stdout: s => {
        stdout += s;
      },
      stderr: s => {
        stderr += `${s}\n`;
      },
      env: {} as NodeJS.ProcessEnv,
    },
  );
  return { stderr, stdout };
}

describe('batch run integration summary', () => {
  it('prints one line and passes the field through in JSON', async () => {
    const integration = { existing: 3, runsAfterWave: true, mayGenerate: true };
    const { stderr, stdout } = await runBatch({ ...BATCH, integration });
    expect(stderr).toContain(
      'Integration phase: 3 existing integration tests run after this wave (0.2 credits each); new ones may be generated on a first run.',
    );
    expect(JSON.parse(stdout).integration).toEqual(integration);
  });

  it('says only what applies when nothing exists yet, and stays silent without the field', async () => {
    const first = await runBatch({
      ...BATCH,
      integration: { existing: 0, runsAfterWave: true, mayGenerate: true },
    });
    expect(first.stderr).toContain('Integration phase: new ones may be generated on a first run.');
    const old = await runBatch(BATCH);
    expect(old.stderr).not.toContain('Integration phase');
    expect(JSON.parse(old.stdout)).not.toHaveProperty('integration');
  });
});

const TEST_ROW: CliTest = {
  id: 'tc1',
  projectId: 'p1',
  name: 'Plain',
  type: 'backend',
  createdFrom: 'cli',
  status: 'passed',
  createdAt: '2026-10-09T00:00:00Z',
  updatedAt: '2026-10-09T00:00:00Z',
};

describe('test list TYPE column', () => {
  it('marks integration tests and leaves other rows untouched', () => {
    const text = renderTestListText({
      items: [TEST_ROW, { ...TEST_ROW, id: 'tc2', name: 'Assembled', isIntegration: true }],
      nextToken: null,
    });
    const lines = text.split('\n');
    expect(lines[0]).toContain('TYPE');
    expect(lines.find(l => l.includes('Assembled'))).toContain('backend/int');
    expect(lines.find(l => l.includes('Plain'))).not.toContain('/int');
    // Columns after TYPE stay aligned under their header.
    const col = (l: string, word: string) => l.indexOf(word);
    expect(col(lines[0]!, 'FROM')).toBe(
      col(
        lines.find(l => l.includes('Assembled'))!,
        'cli',
      ),
    );
  });

  it('renders old-backend rows (no isIntegration) as before', () => {
    expect(renderTestListText({ items: [TEST_ROW], nextToken: null })).not.toContain('/int');
  });
});

const RUN: RunResponse = {
  runId: 'r1',
  testId: 't1',
  projectId: 'p1',
  userId: 'u1',
  status: 'blocked',
  source: 'cli',
  createdAt: '2026-10-09T00:00:00Z',
  startedAt: null,
  finishedAt: null,
  codeVersion: null,
  targetUrl: null,
  createdFrom: 'cli',
  failedStepIndex: null,
  failureKind: null,
  error: null,
  videoUrl: null,
  stepSummary: { total: 0, completed: 0, passedCount: 0, failedCount: 0 },
};

describe('refused replay line', () => {
  it('prints the reason in the key/value block', () => {
    const text = renderRunResponseText({
      ...RUN,
      replay: { path: 'refused', reason: 'stale_code' },
    });
    expect(text).toContain('replay      refused (stale_code)');
  });

  it('prints no replay line for other paths or an absent field', () => {
    expect(renderRunResponseText(RUN)).not.toContain('replay');
    expect(renderRunResponseText({ ...RUN, replay: { path: 'stored' } })).not.toContain('replay ');
  });
});
