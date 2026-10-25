import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizePriority, runCreate, runCreateBatch, runUpdate } from './test.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function makeFetch(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
): typeof globalThis.fetch {
  return (async (input: FetchInput, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : '';
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-prio-'));
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

const UPDATE_OK = { testId: 't1', updatedFields: ['priority'], updatedAt: '2026-10-09T00:00:00Z' };

async function sentUpdateBody(priority: string): Promise<unknown> {
  let seen: unknown;
  const fetchImpl = makeFetch((_u, init) => {
    seen = JSON.parse(init.body as string);
    return { body: UPDATE_OK };
  });
  await runUpdate(
    { profile: 'default', output: 'json', debug: false, testId: 't1', priority },
    { ...makeCreds(), fetchImpl, stdout: () => undefined },
  );
  return seen;
}

describe('priority input', () => {
  it('normalizes aliases and any case to p0/p1/p2', () => {
    expect(
      ['p0', 'High', 'HIGH', 'p1', 'medium', 'p2', 'Low', 'p3'].map(normalizePriority),
    ).toEqual(['p0', 'p0', 'p0', 'p1', 'p1', 'p2', 'p2', 'p2']);
    expect(normalizePriority('p4')).toBeUndefined();
    expect(normalizePriority('urgent')).toBeUndefined();
  });

  it.each([
    ['High', 'p0'],
    ['p1', 'p1'],
    ['medium', 'p1'],
    ['LOW', 'p2'],
    ['p3', 'p2'],
  ])('update sends %s as %s', async (input, wire) => {
    expect(await sentUpdateBody(input)).toEqual({ priority: wire });
  });

  it('update rejects p4 before any request', async () => {
    let called = false;
    const fetchImpl = makeFetch(() => {
      called = true;
      return { body: UPDATE_OK };
    });
    await expect(
      runUpdate(
        { profile: 'default', output: 'json', debug: false, testId: 't1', priority: 'p4' },
        { ...makeCreds(), fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toBe(false);
  });

  it('create-batch normalizes plan priorities and rejects bad ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-prio-batch-'));
    const spec = (name: string, priority: string) => ({
      projectId: 'project_abc',
      type: 'frontend',
      name,
      priority,
      planSteps: [{ type: 'action', description: 'Click' }],
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this suite's own mkdtempSync temp path, never user input
    writeFileSync(join(dir, 'a.json'), JSON.stringify(spec('A', 'High')));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this suite's own mkdtempSync temp path, never user input
    writeFileSync(join(dir, 'b.json'), JSON.stringify(spec('B', 'p1')));
    let sent: { tests: Array<{ priority: string }> } | undefined;
    const fetchImpl = makeFetch((_u, init) => {
      sent = JSON.parse(init.body as string);
      return {
        body: {
          results: [0, 1].map(i => ({ specIndex: i, testId: `t${i}`, status: 'created' })),
          summary: { total: 2, created: 2, failed: 0 },
        },
      };
    });
    const base = {
      plans: '',
      planFromDir: dir,
      output: 'json' as const,
      profile: 'default',
      dryRun: false,
      debug: false,
      verbose: false,
    };
    await runCreateBatch(base, {
      ...makeCreds(),
      fetchImpl,
      stderr: () => undefined,
      stdout: () => undefined,
    });
    expect(sent!.tests.map(t => t.priority)).toEqual(['p0', 'p1']);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this suite's own mkdtempSync temp path, never user input
    writeFileSync(join(dir, 'c.json'), JSON.stringify(spec('C', 'p4')));
    await expect(
      runCreateBatch(base, { ...makeCreds(), fetchImpl, stderr: () => undefined }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
  describe.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'inherited object member %s',
    word => {
      it('is not a priority', () => {
        expect(normalizePriority(word)).toBeUndefined();
      });

      it('update rejects it with zero requests', async () => {
        let calls = 0;
        const fetchImpl = makeFetch(() => {
          calls += 1;
          return { body: UPDATE_OK };
        });
        await expect(
          runUpdate(
            { profile: 'default', output: 'json', debug: false, testId: 't1', priority: word },
            { ...makeCreds(), fetchImpl, stdout: () => undefined },
          ),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
        expect(calls).toBe(0);
      });

      it('create rejects it with zero requests', async () => {
        const codeFile = join(mkdtempSync(join(tmpdir(), 'cli-prio-code-')), 'case.py');
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- this suite's own mkdtempSync temp path, never user input
        writeFileSync(codeFile, 'print("ok")\n');
        let calls = 0;
        const fetchImpl = makeFetch(() => {
          calls += 1;
          return { body: {} };
        });
        await expect(
          runCreate(
            {
              profile: 'default',
              output: 'json',
              debug: false,
              verbose: false,
              projectId: 'project_abc',
              type: 'frontend',
              name: 'N',
              priority: word,
              codeFile,
            } as unknown as Parameters<typeof runCreate>[0],
            { ...makeCreds(), fetchImpl, stderr: () => undefined, stdout: () => undefined },
          ),
        ).rejects.toMatchObject({
          code: 'VALIDATION_ERROR',
          exitCode: 5,
          details: expect.objectContaining({ field: 'priority' }),
        });
        expect(calls).toBe(0);
      });

      it('plan files reject it with zero requests', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cli-prio-proto-'));
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- this suite's own mkdtempSync temp path, never user input
        writeFileSync(
          join(dir, 'a.json'),
          `{"projectId":"project_abc","type":"frontend","name":"A","priority":${JSON.stringify(word)},"planSteps":[{"type":"action","description":"Click"}]}`,
        );
        let calls = 0;
        const fetchImpl = makeFetch(() => {
          calls += 1;
          return { body: {} };
        });
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
            { ...makeCreds(), fetchImpl, stderr: () => undefined, stdout: () => undefined },
          ),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
        expect(calls).toBe(0);
      });
    },
  );
});
