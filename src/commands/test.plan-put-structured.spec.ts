import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGet, runPlanPut } from './test.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type Seen = { method: string; url: string; body: unknown; headers: Headers };

function makeFetch(
  handler: (req: Seen) => { status?: number; body: unknown },
  seen: Seen[] = [],
): typeof globalThis.fetch {
  return (async (input: FetchInput, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';
    const req: Seen = {
      method: init.method ?? 'GET',
      url,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      headers: new Headers(init.headers as Record<string, string>),
    };
    seen.push(req);
    const { status = 200, body } = handler(req);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-structured-'));
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

function stepsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-structured-steps-'));
  const path = join(dir, 'steps.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this suite's own mkdtempSync temp path, never user input
  writeFileSync(
    path,
    JSON.stringify({
      planSteps: [
        { type: 'action', description: 'open /login' },
        { type: 'assertion', description: 'dashboard shows' },
      ],
    }),
  );
  return path;
}

const PUT_OK = { testId: 't1', planStepsHash: 'sha256:x', stepCount: 2, updatedAt: 'now' };
const base = { profile: 'default', output: 'json' as const, debug: false, testId: 't1' };

describe('test plan put fence and --force', () => {
  it('sends no read and no If-Match-Step-Count by default, so write-only keys keep working', async () => {
    const seen: Seen[] = [];
    const fetchImpl = makeFetch(
      r =>
        r.method === 'GET'
          ? { status: 403, body: { error: { code: 'FORBIDDEN' } } }
          : { body: PUT_OK },
      seen,
    );
    await runPlanPut(
      { ...base, stepsFile: stepsFile() },
      { ...makeCreds(), fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seen.map(s => s.method)).toEqual(['PUT']);
    expect(seen[0]!.headers.get('if-match-step-count')).toBeNull();
    expect(seen[0]!.body).not.toHaveProperty('force');
  });

  it('keeps an explicit --expected-step-count and skips the read', async () => {
    const seen: Seen[] = [];
    const fetchImpl = makeFetch(() => ({ body: PUT_OK }), seen);
    await runPlanPut(
      { ...base, stepsFile: stepsFile(), expectedStepCount: 5 },
      { ...makeCreds(), fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seen.map(s => s.method)).toEqual(['PUT']);
    expect(seen[0]!.headers.get('if-match-step-count')).toBe('5');
  });

  it('--force sends force:true with no read and no fence', async () => {
    const seen: Seen[] = [];
    const fetchImpl = makeFetch(() => ({ body: PUT_OK }), seen);
    await runPlanPut(
      { ...base, stepsFile: stepsFile(), force: true },
      { ...makeCreds(), fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seen.map(s => s.method)).toEqual(['PUT']);
    expect(seen[0]!.headers.get('if-match-step-count')).toBeNull();
    expect((seen[0]!.body as { force?: boolean }).force).toBe(true);
  });

  it('renders the structured_loss 412 with the count and step numbers', async () => {
    const stderr: string[] = [];
    const fetchImpl = makeFetch(() => ({
      status: 412,
      body: {
        error: {
          code: 'PRECONDITION_FAILED',
          message: 'This update would drop structured fields from 2 step(s).',
          nextAction: 'Re-run with --force, or edit the steps in the Portal.',
          requestId: 'req_1',
          details: { reason: 'structured_loss', losing: 2, stepIndexes: [0, 3] },
        },
      },
    }));
    await expect(
      runPlanPut(
        { ...base, stepsFile: stepsFile() },
        { ...makeCreds(), fetchImpl, stdout: () => undefined, stderr: l => stderr.push(l) },
      ),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      nextAction: expect.stringContaining('--force'),
    });
    expect(stderr.join('\n')).toContain('2 step(s) would lose their structured fields (step 1, 4)');
  });
});

describe('test get structured steps', () => {
  const run = async (test: unknown, output: 'text' | 'json'): Promise<string> => {
    const out: string[] = [];
    await runGet(
      { profile: 'default', output, debug: false, testId: 't1' },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(() => ({ body: test })),
        stdout: l => out.push(l),
        stderr: () => undefined,
      },
    );
    return out.join('\n');
  };
  const full = {
    id: 't1',
    projectId: 'p1',
    name: 'n',
    type: 'frontend',
    createdFrom: 'cli',
    status: 'passed',
    createdAt: 'x',
    updatedAt: 'y',
    planSteps: [
      { type: 'action', description: 'open', structured: false },
      {
        type: 'action',
        description: 'click save',
        action: 'click',
        selector: '#save',
        structured: true,
      },
    ],
  };

  it('marks structured steps and adds one summary line', async () => {
    const text = await run(full, 'text');
    expect(text).toContain('  1. [action] open');
    expect(text).toContain('* 2. [action] click save');
    expect(text).toContain(
      '* 1 step(s) carry structured fields; `plan put` keeps them only for unchanged steps.',
    );
  });

  it('passes action/selector/inputValue/structured through in JSON', async () => {
    const parsed = JSON.parse(await run(full, 'json'));
    expect(parsed.planSteps[1]).toMatchObject({
      action: 'click',
      selector: '#save',
      structured: true,
    });
  });

  it('renders an old-backend response without the new fields unchanged', async () => {
    const old = { ...full, planSteps: [{ type: 'action', description: 'open' }] };
    const text = await run(old, 'text');
    expect(text).toContain('  1. [action] open');
    expect(text).not.toContain('structured fields');
  });
});
