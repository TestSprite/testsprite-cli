import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { runExport, runImport } from './test.js';

const TEST_ID = 'test_backend_1';
const PROJECT_ID = 'project_alice';
const CODE = 'def test_健康():\n    assert "猫" == "猫"\n\n';
const testRow = {
  id: TEST_ID,
  projectId: PROJECT_ID,
  name: '健康检查',
  type: 'backend',
  createdFrom: 'portal',
  status: 'passed',
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  description: null,
  priority: 'p1',
  stepTimeoutMs: 30000,
  produces: ['token'],
  consumes: ['seed'],
  category: 'setup',
};
const codeRow = {
  testId: TEST_ID,
  language: 'python',
  framework: 'pytest',
  code: CODE,
  codeVersion: 'v7',
  etag: 'v7',
};
const definition = {
  test: {
    id: TEST_ID,
    projectId: PROJECT_ID,
    type: 'backend',
    name: '健康检查',
    description: null,
    priority: 'p1',
    stepTimeoutMs: 30000,
    produces: ['token'],
    consumes: ['seed'],
    category: 'setup',
  },
  code: codeRow,
};

type ExportOptions = Parameters<typeof runExport>[0];
type ImportOptions = Parameters<typeof runImport>[0];

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'definition-'));
  dirs.push(dir);
  return dir;
}

function fixtureFile(value: unknown, raw?: string): string {
  const path = join(tempDir(), 'definition.json');
  writeFileSync(path, raw ?? `${JSON.stringify(value)}\n`, 'utf8');
  return path;
}

function credentials(): string {
  const path = join(tempDir(), 'credentials');
  writeFileSync(
    path,
    '[default]\napi_url = http://localhost:13502\napi_key = sk-user-local-fixture\n',
    {
      mode: 0o600,
    },
  );
  return path;
}

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    stdoutWriter: (line: string) => stdout.push(line),
    stderrWriter: (line: string) => stderr.push(line),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockApi(responder: (call: Call) => Response | Promise<Response>): {
  fetchImpl: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const call: Call = {
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    return responder(call);
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function exportOptions(overrides: Record<string, unknown> = {}): ExportOptions {
  return {
    profile: 'default',
    output: 'json',
    debug: false,
    testId: TEST_ID,
    ...overrides,
  } as ExportOptions;
}

function importOptions(file: string, overrides: Record<string, unknown> = {}): ImportOptions {
  return { profile: 'default', output: 'json', debug: false, file, ...overrides } as ImportOptions;
}

function exportApi() {
  return mockApi(call => {
    if (call.method === 'GET' && call.url.endsWith(`/tests/${TEST_ID}`)) return json(200, testRow);
    if (call.method === 'GET' && call.url.endsWith(`/tests/${TEST_ID}/code`))
      return json(200, codeRow);
    throw new Error(`unexpected request: ${call.method} ${call.url}`);
  });
}

describe('individual backend definition export', () => {
  it('projects writable metadata and exact code with deterministic sorted JSON and no format version', async () => {
    const h = exportApi();
    const output = io();
    const got = await runExport(exportOptions(), {
      credentialsPath: credentials(),
      fetchImpl: h.fetchImpl,
      stdout: output.stdoutWriter,
      stderr: output.stderrWriter,
    });
    expect(got).toEqual(definition);
    expect(
      h.calls.map(call => `${call.method} ${new URL(call.url).pathname.split('/api/cli/v1')[1]}`),
    ).toEqual([`GET /tests/${TEST_ID}`, `GET /tests/${TEST_ID}/code`]);
    expect(output.stdout).toHaveLength(1);
    const printed = `${output.stdout[0]}\n`;
    expect(JSON.parse(printed)).toEqual(definition);
    expect(printed).not.toContain('schemaVersion');
    expect(printed).not.toContain('formatVersion');
    expect(printed).not.toContain('createdAt');
    expect((JSON.parse(printed) as typeof definition).code.code).toBe(CODE);
    expect(printed.endsWith('\n')).toBe(true);
    expect(printed).toBe(stableJson(definition));
  });

  it.each([
    ['High', 'p0'],
    ['Medium', 'p1'],
    ['Low', 'p2'],
    ['p3', 'p2'],
  ])('round-trips priority %s through export and imports it as %s', async (priority, wire) => {
    const h = mockApi(call => {
      if (call.method === 'GET') {
        return json(200, call.url.endsWith('/code') ? codeRow : { ...testRow, priority });
      }
      if (call.method === 'POST') {
        return json(201, { testId: 'test_new', codeVersion: 'v1', createdAt: 'now' });
      }
      if (call.url.endsWith('/code')) {
        return json(200, { testId: TEST_ID, codeVersion: 'v8', updatedAt: 'now' });
      }
      return json(200, { testId: TEST_ID, updatedFields: ['priority'], updatedAt: 'now' });
    });
    const deps = {
      credentialsPath: credentials(),
      fetchImpl: h.fetchImpl,
      stdout: () => undefined,
      stderr: () => undefined,
    };
    const exported = await runExport(exportOptions(), deps);
    expect(exported.test.priority).toBe(priority);
    const file = fixtureFile(exported);
    await runImport(importOptions(file), deps);
    await runImport(importOptions(file, { testId: TEST_ID }), deps);
    const metadataWrites = h.calls.filter(
      call => call.method === 'POST' || (call.method === 'PUT' && !call.url.endsWith('/code')),
    );
    expect(metadataWrites).toHaveLength(2);
    for (const call of metadataWrites) expect(call.body).toMatchObject({ priority: wire });
  });

  it('keeps nullable optional values and safely commits an --out file only after both reads', async () => {
    const h = exportApi();
    const output = io();
    const dir = tempDir();
    const path = join(dir, 'definition.json');
    writeFileSync(path, 'OUTDATED\n');
    await runExport(exportOptions({ out: path }), {
      credentialsPath: credentials(),
      fetchImpl: h.fetchImpl,
      stdout: output.stdoutWriter,
      stderr: output.stderrWriter,
    });
    expect(readFileSync(path, 'utf8')).toBe(stableJson(definition));
    expect(output.stdout).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf8')).test.description).toBeNull();
    expect(readdirSync(dir)).toEqual(['definition.json']);
  });

  it('rejects frontend metadata before reading code and leaves no artifact', async () => {
    const h = mockApi(call => {
      if (call.method === 'GET' && call.url.endsWith(`/tests/${TEST_ID}`)) {
        return json(200, {
          ...testRow,
          type: 'frontend',
          planSteps: [{ type: 'action', description: 'click' }],
        });
      }
      throw new Error('frontend export must stop after metadata');
    });
    const path = join(tempDir(), 'definition.json');
    await expect(
      runExport(exportOptions({ out: path }), {
        credentialsPath: credentials(),
        fetchImpl: h.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(h.calls).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to combine metadata or code returned for another test id', async () => {
    for (const wrong of ['metadata', 'code'] as const) {
      const h = mockApi(call => {
        if (call.url.endsWith('/code')) {
          return json(200, { ...codeRow, testId: wrong === 'code' ? 'test_other' : TEST_ID });
        }
        return json(200, { ...testRow, id: wrong === 'metadata' ? 'test_other' : TEST_ID });
      });
      const output = io();
      await expect(
        runExport(exportOptions(), {
          credentialsPath: credentials(),
          fetchImpl: h.fetchImpl,
          stdout: output.stdoutWriter,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(h.calls).toHaveLength(wrong === 'metadata' ? 1 : 2);
      expect(output.stdout).toEqual([]);
    }
  });

  it('resolves a presigned body without forwarding facade credentials and refuses oversize source', async () => {
    const url = 'https://signed.example.test/code.py?sig=fixture';
    const h = mockApi(call => {
      if (call.url.endsWith(`/tests/${TEST_ID}`)) return json(200, testRow);
      if (call.url.endsWith(`/tests/${TEST_ID}/code`)) return json(200, { ...codeRow, code: url });
      if (call.url === url) return new Response(CODE, { status: 200 });
      throw new Error(`unexpected request: ${call.url}`);
    });
    const output = io();
    const got = await runExport(exportOptions(), {
      credentialsPath: credentials(),
      fetchImpl: h.fetchImpl,
      stdout: output.stdoutWriter,
      stderr: output.stderrWriter,
    });
    expect(got.code.code).toBe(CODE);
    expect(h.calls[2]?.url).toBe(url);
    expect(h.calls[2]?.headers.has('authorization')).toBe(false);
    expect(h.calls[2]?.headers.has('idempotency-key')).toBe(false);

    const tooLarge = mockApi(call => {
      if (call.url.endsWith(`/tests/${TEST_ID}`)) return json(200, testRow);
      if (call.url.endsWith(`/tests/${TEST_ID}/code`)) return json(200, { ...codeRow, code: url });
      if (call.url === url) return new Response('x'.repeat(350 * 1024 + 1), { status: 200 });
      throw new Error('unexpected request');
    });
    const path = join(tempDir(), 'too-large.json');
    writeFileSync(path, 'PREVIOUS\n');
    await expect(
      runExport(exportOptions({ out: path }), {
        credentialsPath: credentials(),
        fetchImpl: tooLarge.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(readFileSync(path, 'utf8')).toBe('PREVIOUS\n');
    expect(readdirSync(join(path, '..'))).toEqual(['too-large.json']);
  });

  it('preserves the validation exit code when streamed presigned source crosses 350 KB', async () => {
    const url = 'https://signed.example.test/code.py?sig=fixture';
    const chunks = ['x'.repeat(350 * 1024), 'y'];
    const h = mockApi(call => {
      if (call.url.endsWith(`/tests/${TEST_ID}`)) return json(200, testRow);
      if (call.url.endsWith(`/tests/${TEST_ID}/code`)) return json(200, { ...codeRow, code: url });
      if (call.url === url) {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const chunk = chunks.shift();
              if (chunk === undefined) controller.close();
              else controller.enqueue(new TextEncoder().encode(chunk));
            },
          }),
        );
      }
      throw new Error(`unexpected request: ${call.url}`);
    });
    const path = join(tempDir(), 'definition.json');
    writeFileSync(path, 'PREVIOUS\n');
    const output = io();
    const error = await runExport(exportOptions({ out: path }), {
      credentialsPath: credentials(),
      fetchImpl: h.fetchImpl,
      stdout: output.stdoutWriter,
      stderr: output.stderrWriter,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(
      (error as ApiError).getDetail('field', (value): value is string => typeof value === 'string'),
    ).toBe('code.code');
    expect(output.stdout).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('PREVIOUS\n');
    expect(readdirSync(join(path, '..'))).toEqual(['definition.json']);
  });

  it('preserves an existing --out file when the second API read fails', async () => {
    const path = join(tempDir(), 'existing.json');
    writeFileSync(path, 'PREVIOUS\n');
    const h = mockApi(call => {
      if (call.url.endsWith(`/tests/${TEST_ID}`)) return json(200, testRow);
      return json(400, {
        error: { code: 'VALIDATION_ERROR', message: 'fixture failure', requestId: 'fixture' },
      });
    });
    await expect(
      runExport(exportOptions({ out: path }), {
        credentialsPath: credentials(),
        fetchImpl: h.fetchImpl,
      }),
    ).rejects.toBeDefined();
    expect(readFileSync(path, 'utf8')).toBe('PREVIOUS\n');
    expect(readdirSync(join(path, '..'))).toEqual(['existing.json']);
  });

  it('dry-run emits a backend sample without reading credentials, calling fetch, or writing --out', async () => {
    const path = join(tempDir(), 'dry-run.json');
    const output = io();
    const fetchImpl = (() => {
      throw new Error('dry-run reached fetch');
    }) as typeof globalThis.fetch;
    const got = await runExport(exportOptions({ dryRun: true, out: path }), {
      fetchImpl,
      stdout: output.stdoutWriter,
      stderr: output.stderrWriter,
    });
    expect(got.test.type).toBe('backend');
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0]!)).toEqual(got);
    expect(existsSync(path)).toBe(false);
  });

  it('produces identical literal bytes from differently ordered API objects', async () => {
    const firstMeta = {
      id: TEST_ID,
      projectId: PROJECT_ID,
      type: 'backend',
      name: 'A',
      status: 'passed',
    };
    const secondMeta = {
      status: 'passed',
      name: 'A',
      type: 'backend',
      projectId: PROJECT_ID,
      id: TEST_ID,
    };
    const firstCode = {
      testId: TEST_ID,
      language: 'python',
      framework: 'pytest',
      code: 'def test_ok():\n    assert True\n',
      codeVersion: 'v1',
    };
    const secondCode = {
      codeVersion: 'v1',
      code: 'def test_ok():\n    assert True\n',
      framework: 'pytest',
      language: 'python',
      testId: TEST_ID,
    };
    const bodies: string[] = [];
    for (const [metadata, source] of [
      [firstMeta, firstCode],
      [secondMeta, secondCode],
    ] as const) {
      const h = mockApi(call => json(200, call.url.endsWith('/code') ? source : metadata));
      const output = io();
      await runExport(exportOptions(), {
        credentialsPath: credentials(),
        fetchImpl: h.fetchImpl,
        stdout: output.stdoutWriter,
      });
      bodies.push(`${output.stdout[0]}\n`);
    }
    const literal =
      '{\n' +
      '  "code": {\n' +
      '    "code": "def test_ok():\\n    assert True\\n",\n' +
      '    "codeVersion": "v1",\n' +
      '    "framework": "pytest",\n' +
      '    "language": "python",\n' +
      '    "testId": "test_backend_1"\n' +
      '  },\n' +
      '  "test": {\n' +
      '    "id": "test_backend_1",\n' +
      '    "name": "A",\n' +
      '    "projectId": "project_alice",\n' +
      '    "type": "backend"\n' +
      '  }\n' +
      '}\n';
    expect(bodies).toEqual([literal, literal]);
  });
});

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sort(v)]),
      );
    }
    return item;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

describe('individual backend definition import', () => {
  it('creates by default, even with saved provenance id, and omits nullable create fields', async () => {
    const file = fixtureFile(definition);
    const output = io();
    const h = mockApi(call => {
      expect(call.method).toBe('POST');
      expect(call.url).toMatch(/\/tests$/);
      return json(201, {
        testId: 'test_new',
        type: 'backend',
        codeVersion: 'v1',
        createdAt: 'now',
      });
    });
    const result = await runImport(importOptions(file, { idempotencyKey: 'replay-1' }), {
      credentialsPath: credentials(),
      fetchImpl: h.fetchImpl,
      stdout: output.stdoutWriter,
      stderr: output.stderrWriter,
    });
    expect(result).toEqual({ testId: 'test_new', action: 'created', codeVersion: 'v1' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.headers.get('idempotency-key')).toBe('replay-1:create');
    expect(h.calls[0]?.body).toEqual({
      projectId: PROJECT_ID,
      type: 'backend',
      name: '健康检查',
      priority: 'p1',
      stepTimeoutMs: 30000,
      produces: ['token'],
      consumes: ['seed'],
      category: 'setup',
      code: CODE,
    });
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0]!)).toEqual(result);
  });

  it('prints a replayable minted key to stderr and derives the create request key', async () => {
    const output = io();
    const h = mockApi(() =>
      json(201, { testId: 'test_new', type: 'backend', codeVersion: 'v1', createdAt: 'now' }),
    );
    await runImport(importOptions(fixtureFile(definition)), {
      credentialsPath: credentials(),
      fetchImpl: h.fetchImpl,
      stdout: output.stdoutWriter,
      stderr: output.stderrWriter,
    });
    const minted = output.stderr.find(line => line.startsWith('idempotency-key: '))?.slice(17);
    expect(minted).toMatch(/^cli-import-[0-9a-f-]{36}$/);
    expect(h.calls[0]?.headers.get('idempotency-key')).toBe(`${minted}:create`);
    expect(output.stdout).toHaveLength(1);
  });

  it('updates code before metadata with saved version and derived replay keys', async () => {
    const file = fixtureFile(definition);
    const output = io();
    const h = mockApi(call => {
      if (call.method === 'GET') return json(200, testRow);
      if (call.url.endsWith('/code'))
        return json(200, { testId: TEST_ID, codeVersion: 'v8', updatedAt: 'now' });
      return json(200, { testId: TEST_ID, updatedFields: ['name'], updatedAt: 'now' });
    });
    const result = await runImport(
      importOptions(file, { testId: TEST_ID, idempotencyKey: 'same-key' }),
      {
        credentialsPath: credentials(),
        fetchImpl: h.fetchImpl,
        stdout: output.stdoutWriter,
        stderr: output.stderrWriter,
      },
    );
    expect(result).toEqual({ testId: TEST_ID, action: 'updated', codeVersion: 'v8' });
    expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT', 'PUT']);
    expect(h.calls[1]?.url).toMatch(/\/tests\/test_backend_1\/code$/);
    expect(h.calls[1]?.headers.get('if-match')).toBe('v7');
    expect(h.calls[1]?.headers.get('idempotency-key')).toBe('same-key:code');
    expect(h.calls[1]?.body).toEqual({ code: CODE, language: 'python' });
    expect(h.calls[2]?.headers.get('idempotency-key')).toBe('same-key:metadata');
    expect(h.calls[2]?.body).toMatchObject({
      name: '健康检查',
      description: null,
      priority: 'p1',
      stepTimeoutMs: 30000,
      produces: ['token'],
      consumes: ['seed'],
      category: 'setup',
    });
    expect(JSON.parse(output.stdout[0]!)).toEqual(result);
  });

  it('uses an explicit version for the same or a different target and applies a create project override', async () => {
    const file = fixtureFile(definition);
    const create = mockApi(() =>
      json(201, { testId: 'test_new', type: 'backend', codeVersion: 'v1', createdAt: 'now' }),
    );
    await runImport(importOptions(file, { projectId: 'project_migrated' }), {
      credentialsPath: credentials(),
      fetchImpl: create.fetchImpl,
      stdout: () => undefined,
    });
    expect((create.calls[0]?.body as { projectId: string }).projectId).toBe('project_migrated');

    for (const targetId of [TEST_ID, 'test_other']) {
      const target = mockApi(call => {
        if (call.method === 'GET') return json(200, { ...testRow, id: targetId });
        if (call.url.endsWith('/code'))
          return json(200, { testId: targetId, codeVersion: 'v12', updatedAt: 'now' });
        return json(200, { testId: targetId, updatedFields: ['name'], updatedAt: 'now' });
      });
      await runImport(importOptions(file, { testId: targetId, expectedVersion: 'v11' }), {
        credentialsPath: credentials(),
        fetchImpl: target.fetchImpl,
        stdout: () => undefined,
      });
      expect(target.calls[1]?.headers.get('if-match')).toBe('v11');
    }
  });

  it('does not write metadata after a code-version conflict', async () => {
    const file = fixtureFile(definition);
    const h = mockApi(call => {
      if (call.method === 'GET') return json(200, testRow);
      return json(412, {
        error: {
          code: 'PRECONDITION_FAILED',
          message: 'version changed',
          requestId: 'fixture',
          details: { currentCodeVersion: 'v9' },
        },
      });
    });
    await expect(
      runImport(importOptions(file, { testId: TEST_ID }), {
        credentialsPath: credentials(),
        fetchImpl: h.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', exitCode: 6 });
    expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT']);
    expect(h.calls[1]?.headers.get('if-match')).toBe('v7');
  });

  it('surfaces metadata failure after a successful code PUT with a partial-update warning', async () => {
    const file = fixtureFile(definition);
    const output = io();
    const h = mockApi(call => {
      if (call.method === 'GET') return json(200, testRow);
      if (call.url.endsWith('/code'))
        return json(200, { testId: TEST_ID, codeVersion: 'v8', updatedAt: 'now' });
      return json(400, {
        error: { code: 'VALIDATION_ERROR', message: 'metadata rejected', requestId: 'fixture' },
      });
    });
    await expect(
      runImport(importOptions(file, { testId: TEST_ID }), {
        credentialsPath: credentials(),
        fetchImpl: h.fetchImpl,
        stdout: output.stdoutWriter,
        stderr: output.stderrWriter,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.calls.map(call => call.method)).toEqual(['GET', 'PUT', 'PUT']);
    expect(output.stdout).toEqual([]);
    expect(output.stderr.join('\n')).toMatch(/partial|code.*updated|metadata/i);
  });

  it('replays both mutation keys after an ambiguous metadata failure and rejects a new stale key', async () => {
    const file = fixtureFile(definition);
    let currentVersion = 'v7';
    let firstMetadataFailure = true;
    const codeReceipts = new Map<
      string,
      { testId: string; codeVersion: string; updatedAt: string }
    >();
    const h = mockApi(call => {
      if (call.method === 'GET') return json(200, testRow);
      if (call.url.endsWith('/code')) {
        const key = call.headers.get('idempotency-key')!;
        const cached = codeReceipts.get(key);
        if (cached) return json(200, cached);
        if (call.headers.get('if-match') !== currentVersion) {
          return json(412, {
            error: { code: 'PRECONDITION_FAILED', message: 'stale code', requestId: 'fixture' },
          });
        }
        currentVersion = 'v8';
        const receipt = { testId: TEST_ID, codeVersion: currentVersion, updatedAt: 'now' };
        codeReceipts.set(key, receipt);
        return json(200, receipt);
      }
      if (firstMetadataFailure) {
        firstMetadataFailure = false;
        return json(400, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'ambiguous first metadata response',
            requestId: 'fixture',
          },
        });
      }
      return json(200, { testId: TEST_ID, updatedFields: ['name'], updatedAt: 'now' });
    });
    const opts = importOptions(file, { testId: TEST_ID, idempotencyKey: 'replay-base' });
    await expect(
      runImport(opts, {
        credentialsPath: credentials(),
        fetchImpl: h.fetchImpl,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const result = await runImport(opts, {
      credentialsPath: credentials(),
      fetchImpl: h.fetchImpl,
      stdout: () => undefined,
    });
    expect(result).toEqual({ testId: TEST_ID, action: 'updated', codeVersion: 'v8' });
    expect(
      h.calls
        .filter(call => call.url.endsWith('/code'))
        .map(call => call.headers.get('idempotency-key')),
    ).toEqual(['replay-base:code', 'replay-base:code']);
    expect(
      h.calls
        .filter(call => call.method === 'PUT' && !call.url.endsWith('/code'))
        .map(call => call.headers.get('idempotency-key')),
    ).toEqual(['replay-base:metadata', 'replay-base:metadata']);

    const countBeforeStaleRetry = h.calls.length;
    await expect(
      runImport(importOptions(file, { testId: TEST_ID, idempotencyKey: 'new-base' }), {
        credentialsPath: credentials(),
        fetchImpl: h.fetchImpl,
        stdout: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(h.calls.slice(countBeforeStaleRetry).map(call => call.method)).toEqual(['GET', 'PUT']);
  });

  it('requires explicit version for a different update target and rejects target project/type mismatch', async () => {
    const file = fixtureFile(definition);
    const noCalls = mockApi(() => {
      throw new Error('must fail locally');
    });
    await expect(
      runImport(importOptions(file, { testId: 'test_other' }), {
        credentialsPath: credentials(),
        fetchImpl: noCalls.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(noCalls.calls).toEqual([]);
    await expect(
      runImport(importOptions(file, { testId: TEST_ID, projectId: 'another_project' }), {
        credentialsPath: credentials(),
        fetchImpl: noCalls.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(noCalls.calls).toEqual([]);

    const mismatch = mockApi(() =>
      json(200, { ...testRow, id: 'test_other', projectId: 'project_elsewhere' }),
    );
    await expect(
      runImport(importOptions(file, { testId: 'test_other', expectedVersion: 'v4' }), {
        credentialsPath: credentials(),
        fetchImpl: mismatch.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(mismatch.calls).toHaveLength(1);
  });

  it('rejects absent/null code versions and overlong derived idempotency keys before network', async () => {
    const h = mockApi(() => {
      throw new Error('must fail locally');
    });
    for (const version of [null, undefined]) {
      const file = fixtureFile({ ...definition, code: { ...codeRow, codeVersion: version } });
      await expect(
        runImport(importOptions(file, { testId: TEST_ID }), {
          credentialsPath: credentials(),
          fetchImpl: h.fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    const file = fixtureFile(definition);
    await expect(
      runImport(importOptions(file, { idempotencyKey: 'x'.repeat(254) }), {
        credentialsPath: credentials(),
        fetchImpl: h.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    for (const expectedVersion of ['*', '   ']) {
      await expect(
        runImport(importOptions(file, { testId: TEST_ID, expectedVersion }), {
          credentialsPath: credentials(),
          fetchImpl: h.fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(h.calls).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects directories, devices, and FIFOs as import files before network',
    async () => {
      const dir = tempDir();
      const fifo = join(dir, 'pipe');
      execFileSync('mkfifo', [fifo]);
      const h = mockApi(() => {
        throw new Error('non-regular file reached network');
      });
      for (const file of [dir, '/dev/null', fifo]) {
        await expect(
          runImport(importOptions(file), { fetchImpl: h.fetchImpl }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
      }
      expect(h.calls).toEqual([]);
    },
  );

  it('validates the file shape and syntax before any client request', async () => {
    const h = mockApi(() => {
      throw new Error('must fail locally');
    });
    const cases = [
      fixtureFile(definition, '{bad json'),
      fixtureFile({ ...definition, schemaVersion: 1 }),
      fixtureFile({ ...definition, test: { ...definition.test, unexpected: true } }),
      fixtureFile({ ...definition, test: { ...definition.test, type: 'frontend' } }),
      fixtureFile({ ...definition, code: { ...codeRow, code: 'x'.repeat(350 * 1024 + 1) } }),
      fixtureFile(definition, 'x'.repeat(1024 * 1024 + 1)),
    ];
    for (const file of cases) {
      await expect(
        runImport(importOptions(file), {
          credentialsPath: credentials(),
          fetchImpl: h.fetchImpl,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    await expect(
      runImport(importOptions(join(tempDir(), 'missing.json')), {
        credentialsPath: credentials(),
        fetchImpl: h.fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.calls).toEqual([]);
  });

  it('rejects wrong optional and required field types without dropping them', async () => {
    const h = mockApi(() => {
      throw new Error('malformed file reached network');
    });
    const variants: unknown[] = [
      { ...definition, test: { ...definition.test, description: {} } },
      { ...definition, test: { ...definition.test, priority: 'urgent' } },
      { ...definition, test: { ...definition.test, stepTimeoutMs: [] } },
      { ...definition, test: { ...definition.test, produces: [null] } },
      { ...definition, test: { ...definition.test, consumes: {} } },
      { ...definition, test: { ...definition.test, category: [] } },
      { ...definition, test: { ...definition.test, name: null } },
      { ...definition, code: { ...codeRow, code: '' } },
      { ...definition, code: { ...codeRow, code: null } },
      { ...definition, code: { ...codeRow, codeVersion: [] } },
      { ...definition, code: { ...codeRow, language: 'typescript' } },
      { ...definition, code: { ...codeRow, testId: 'another_test' } },
      { ...definition, code: { ...codeRow, framework: 'playwright' } },
    ];
    for (const value of variants) {
      const file = fixtureFile(value);
      await expect(
        runImport(importOptions(file), { fetchImpl: h.fetchImpl }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    const withoutCode = { test: definition.test };
    const withoutProject = { ...definition, test: { type: 'backend', name: 'A' } };
    for (const value of [withoutCode, withoutProject]) {
      await expect(
        runImport(importOptions(fixtureFile(value)), { fetchImpl: h.fetchImpl }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(h.calls).toEqual([]);
  });

  it('preserves nullable exported fields while omitting absent fields from a sparse metadata update', async () => {
    const nullable = {
      ...definition,
      test: {
        ...definition.test,
        description: null,
        priority: null,
        stepTimeoutMs: null,
        produces: null,
        consumes: null,
        category: null,
      },
    };
    const create = mockApi(() =>
      json(201, { testId: 'test_new', type: 'backend', codeVersion: 'v1', createdAt: 'now' }),
    );
    await runImport(importOptions(fixtureFile(nullable)), {
      credentialsPath: credentials(),
      fetchImpl: create.fetchImpl,
      stdout: () => undefined,
    });
    expect(create.calls[0]?.body).toEqual({
      projectId: PROJECT_ID,
      type: 'backend',
      name: '健康检查',
      code: CODE,
    });

    const sparse = {
      test: { id: TEST_ID, projectId: PROJECT_ID, type: 'backend', name: 'Renamed' },
      code: codeRow,
    };
    const update = mockApi(call => {
      if (call.method === 'GET') return json(200, testRow);
      if (call.url.endsWith('/code'))
        return json(200, { testId: TEST_ID, codeVersion: 'v8', updatedAt: 'now' });
      return json(200, { testId: TEST_ID, updatedFields: ['name'], updatedAt: 'now' });
    });
    await runImport(importOptions(fixtureFile(sparse), { testId: TEST_ID }), {
      credentialsPath: credentials(),
      fetchImpl: update.fetchImpl,
      stdout: () => undefined,
    });
    expect(update.calls[2]?.body).toEqual({ name: 'Renamed' });
  });

  it('accepts a BOM-prefixed exported definition and preserves code whitespace', async () => {
    const file = fixtureFile(definition, `\uFEFF${JSON.stringify(definition)}`);
    const h = mockApi(call => {
      expect((call.body as { code: string }).code).toBe(CODE);
      return json(201, {
        testId: 'test_new',
        type: 'backend',
        codeVersion: 'v1',
        createdAt: 'now',
      });
    });
    await runImport(importOptions(file), {
      credentialsPath: credentials(),
      fetchImpl: h.fetchImpl,
      stdout: () => undefined,
    });
    expect(h.calls).toHaveLength(1);
  });

  it('allows null code-version provenance on create without sending concurrency headers', async () => {
    const file = fixtureFile({ ...definition, code: { ...codeRow, codeVersion: null } });
    const h = mockApi(() =>
      json(201, { testId: 'test_new', type: 'backend', codeVersion: 'v1', createdAt: 'now' }),
    );
    await runImport(importOptions(file), {
      credentialsPath: credentials(),
      fetchImpl: h.fetchImpl,
      stdout: () => undefined,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.headers.has('if-match')).toBe(false);
  });

  it('dry-run reads and validates the file without credentials or network', async () => {
    const file = fixtureFile(definition);
    const output = io();
    const result = await runImport(importOptions(file, { dryRun: true }), {
      stdout: output.stdoutWriter,
      stderr: output.stderrWriter,
    });
    expect(result.action).toBe('created');
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0]!)).toEqual(result);
    const malformed = fixtureFile(definition, '{bad json');
    await expect(
      runImport(importOptions(malformed, { dryRun: true }), {
        stdout: output.stdoutWriter,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
