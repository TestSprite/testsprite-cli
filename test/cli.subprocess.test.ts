/**
 * Subprocess test that builds the CLI binary and runs it as a real child
 * process against an in-memory HTTP server. Catches packaging / ESM /
 * shebang issues that unit tests cannot see.
 *
 * Per design.md §12.4 hard gate: "Subprocess test that builds the binary
 * and runs `auth whoami` against the mock."
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

const ME_BODY = {
  userId: 'u-subproc',
  keyId: 'k-subproc',
  scopes: ['read:projects', 'read:tests'],
  env: 'development',
};

let server: Server;
let baseUrl: string;
let tmpHome: string;

beforeAll(async () => {
  // Always rebuild — `npm run build` is fast and a stale `dist/index.js`
  // would silently mask ESM/import regressions in this suite. The
  // existsSync skip we used to do here let `dist` rot under
  // refactors and gave false-green on `project list` once
  // already.
  execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    if (url.startsWith('/api/cli/v1/projects/')) {
      const id = url.replace('/api/cli/v1/projects/', '').split('?')[0]!;
      const apiKey = req.headers['x-api-key'];
      if (typeof apiKey !== 'string' || apiKey === '') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'AUTH_REQUIRED',
              message: 'Authentication is required.',
              nextAction: '',
              requestId: 'req_subproc',
              details: {},
            },
          }),
        );
        return;
      }
      if (id === 'project_subproc') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'project_subproc',
            name: 'Subproc Fixture',
            type: 'frontend',
            createdFrom: 'portal',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-05T00:00:00.000Z',
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            message: 'Resource not found.',
            nextAction: '',
            requestId: 'req_subproc',
            details: { resource: 'project', id },
          },
        }),
      );
      return;
    }
    if (url.startsWith('/api/cli/v1/tests/')) {
      const tail = url.replace('/api/cli/v1/tests/', '').split('?')[0]!;
      const apiKey = req.headers['x-api-key'];
      if (typeof apiKey !== 'string' || apiKey === '') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'AUTH_REQUIRED',
              message: 'Authentication is required.',
              nextAction: '',
              requestId: 'req_subproc',
              details: {},
            },
          }),
        );
        return;
      }
      const segments = tail.split('/');
      const testId = segments[0]!;
      const subPath = segments[1];
      if (testId === 'test_subproc' && subPath === undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'test_subproc',
            projectId: 'project_subproc',
            name: 'Subproc test fixture',
            type: 'frontend',
            createdFrom: 'portal',
            status: 'failed',
            createdAt: '2026-04-20T11:00:00.000Z',
            updatedAt: '2026-05-05T12:34:56.000Z',
          }),
        );
        return;
      }
      if (testId === 'test_subproc' && subPath === 'code') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            testId: 'test_subproc',
            language: 'typescript',
            framework: 'playwright',
            code: [
              "import { test } from '@playwright/test';",
              "test('subproc happy path', async () => {});",
              '',
            ].join('\n'),
            codeVersion: 'v3',
            etag: 'sha256:subproc',
          }),
        );
        return;
      }
      if (testId === 'test_subproc' && subPath === 'steps') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            items: [
              {
                testId: 'test_subproc',
                stepIndex: 1,
                action: 'click',
                description: 'Click the cart icon',
                status: 'passed',
                screenshotUrl: 'https://example.com/01.png',
                htmlSnapshotUrl: 'https://example.com/01.html',
                runIdIfAvailable: 'run_subproc',
                codeVersion: 'v3',
                capturedAt: '2026-05-05T12:34:55.000Z',
                updatedAt: '2026-05-05T12:34:55.000Z',
              },
              {
                testId: 'test_subproc',
                stepIndex: 2,
                action: 'click',
                description: 'Click the submit button',
                status: 'failed',
                screenshotUrl: 'https://example.com/02.png',
                htmlSnapshotUrl: 'https://example.com/02.html',
                runIdIfAvailable: 'run_subproc',
                codeVersion: 'v3',
                capturedAt: '2026-05-05T12:34:56.000Z',
                updatedAt: '2026-05-05T12:34:56.000Z',
              },
            ],
            nextToken: null,
          }),
        );
        return;
      }
      if (testId === 'test_subproc' && subPath === 'result') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            testId: 'test_subproc',
            status: 'failed',
            startedAt: '2026-05-05T12:34:00.000Z',
            finishedAt: '2026-05-05T12:34:58.000Z',
            videoUrl: 'https://example.com/run_subproc.mp4',
            failureAnalysisUrl: 'https://example.com/analysis.json',
            snapshotId: 'snap_subproc',
            runIdIfAvailable: 'run_subproc',
            codeVersion: 'v3',
            targetUrl: 'https://staging.example.com/checkout',
            failedStepIndex: 2,
            failureKind: 'assertion',
            summary: { passed: 1, failed: 1, skipped: 0 },
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            message: 'Resource not found.',
            nextAction: '',
            requestId: 'req_subproc',
            details: { resource: 'test', id: tail },
          },
        }),
      );
      return;
    }
    if (url.startsWith('/api/cli/v1/tests')) {
      const apiKey = req.headers['x-api-key'];
      if (typeof apiKey !== 'string' || apiKey === '') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'AUTH_REQUIRED',
              message: 'Authentication is required.',
              nextAction: 'Run `testsprite auth configure`.',
              requestId: 'req_subproc',
              details: {},
            },
          }),
        );
        return;
      }
      const params = new URLSearchParams(url.split('?')[1] ?? '');
      const projectId = params.get('projectId');
      if (!projectId) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request.',
              nextAction: 'Field `projectId` is required.',
              requestId: 'req_subproc',
              details: { field: 'projectId', reason: 'required' },
            },
          }),
        );
        return;
      }
      const items = [
        {
          id: 'test_subproc',
          projectId: 'project_subproc',
          name: 'Subproc test fixture',
          type: 'frontend' as const,
          createdFrom: 'portal' as const,
          status: 'failed' as const,
          createdAt: '2026-04-20T11:00:00.000Z',
          updatedAt: '2026-05-05T12:34:56.000Z',
        },
      ];
      const typeFilter = params.get('type');
      const filtered = typeFilter ? items.filter(t => t.type === typeFilter) : items;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: filtered, nextToken: null }));
      return;
    }
    if (url.startsWith('/api/cli/v1/projects')) {
      const apiKey = req.headers['x-api-key'];
      if (typeof apiKey !== 'string' || apiKey === '') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'AUTH_REQUIRED',
              message: 'Authentication is required.',
              nextAction: 'Run `testsprite auth configure`.',
              requestId: 'req_subproc',
              details: {},
            },
          }),
        );
        return;
      }
      // Single-project listing — enough to exercise text+json paths.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [
            {
              id: 'project_subproc',
              name: 'Subproc Fixture',
              type: 'frontend',
              createdFrom: 'portal',
              createdAt: '2026-05-01T00:00:00.000Z',
              updatedAt: '2026-05-05T00:00:00.000Z',
            },
          ],
          nextToken: null,
        }),
      );
      return;
    }
    if (url === '/api/cli/v1/me') {
      const apiKey = req.headers['x-api-key'];
      if (typeof apiKey !== 'string' || apiKey === '') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'AUTH_REQUIRED',
              message: 'Authentication is required.',
              nextAction: 'Run `testsprite auth configure`.',
              requestId: 'req_subproc',
              details: {},
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ME_BODY));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'NOT_FOUND',
          message: 'Not found.',
          nextAction: '',
          requestId: 'req_subproc',
          details: {},
        },
      }),
    );
  });
  await new Promise<void>(resolveListen => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('server.address() did not return an AddressInfo');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  tmpHome = mkdtempSync(join(tmpdir(), 'testsprite-subproc-'));
}, 60_000);

afterAll(async () => {
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
});

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], envOverrides: Record<string, string> = {}): Promise<SpawnResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn('node', [BIN_PATH, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: tmpHome,
        TESTSPRITE_API_KEY: undefined,
        TESTSPRITE_API_URL: undefined,
        ...envOverrides,
      } as NodeJS.ProcessEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk.toString()));
    child.stderr.on('data', chunk => (stderr += chunk.toString()));
    child.on('error', rejectResult);
    child.on('close', code => resolveResult({ exitCode: code ?? -1, stdout, stderr }));
  });
}

describe('auth status subprocess (+ deprecated whoami alias)', () => {
  it('prints JSON me and exits 0 against the local server', async () => {
    const result = await runCli(['auth', 'status', '--output', 'json'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual(ME_BODY);
    expect(result.stderr).toBe('');
  }, 30_000);

  it('exits 3 with AUTH_REQUIRED when no key is configured (text mode)', async () => {
    const result = await runCli(['auth', 'status'], {
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('Authentication is required.');
    expect(result.stderr).toContain('testsprite setup');
  }, 30_000);

  it('--output json emits a parseable error envelope on AUTH_REQUIRED', async () => {
    const result = await runCli(['--output', 'json', 'auth', 'status'], {
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(3);
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; nextAction: string; requestId: string };
    };
    expect(parsed.error.code).toBe('AUTH_REQUIRED');
    expect(parsed.error.nextAction).toContain('testsprite setup');
  }, 30_000);

  it('text mode renders userId/scopes legibly', async () => {
    const result = await runCli(['auth', 'status'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('userId: u-subproc');
    expect(result.stdout).toContain('scopes: read:projects, read:tests');
  }, 30_000);

  it('--debug emits structured debug events to stderr without leaking the key', async () => {
    const result = await runCli(['--debug', 'auth', 'status', '--output', 'json'], {
      TESTSPRITE_API_KEY: 'sk-subproc-secret',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('"kind":"request"');
    expect(result.stderr).toContain('"kind":"response"');
    expect(result.stderr).not.toContain('sk-subproc-secret');
    expect(result.stderr).not.toContain('x-api-key');
  }, 30_000);

  it('deprecated `auth whoami` alias still works and prints a deprecation notice', async () => {
    const result = await runCli(['auth', 'whoami', '--output', 'json'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(ME_BODY);
    expect(result.stderr).toContain('[deprecated]');
    expect(result.stderr).toContain('auth status');
  }, 30_000);
});

describe('project list subprocess', () => {
  it('--output json returns the §6.1 ProjectList shape', async () => {
    const result = await runCli(['--output', 'json', 'project', 'list'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe('project_subproc');
    expect(parsed.nextToken).toBeNull();
  }, 30_000);

  it('text output renders a header row and the project name', async () => {
    const result = await runCli(['project', 'list'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ID');
    expect(result.stdout).toContain('NAME');
    expect(result.stdout).toContain('Subproc Fixture');
  }, 30_000);

  it('--help prints flag documentation for pagination', async () => {
    const result = await runCli(['project', 'list', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--page-size');
    expect(result.stdout).toContain('--starting-token');
    expect(result.stdout).toContain('--max-items');
  }, 30_000);

  it('--page-size 0 exits 5 (VALIDATION_ERROR), not 1 (generic)', async () => {
    const result = await runCli(['--output', 'json', 'project', 'list', '--page-size', '0'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  }, 30_000);

  it('--page-size 101 exits 5 (VALIDATION_ERROR) — upper-bound enforced client-side', async () => {
    // Previously silently clamped to 100; now rejected at exit 5 so callers
    // get fast feedback that the value is out of range (Fix 7 — B-E2E-01 wave).
    const result = await runCli(['--output', 'json', 'project', 'list', '--page-size', '101'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  }, 30_000);
});

describe('malformed --endpoint-url is rejected (exit 5), not retried as a network error', () => {
  // Previously: a malformed endpoint surfaced either as an opaque `Invalid URL`
  // (exit 1) or, for a missing/wrong scheme, as a `fetch failed` UNAVAILABLE
  // only after a full retry-and-backoff cycle. Both are misleading config
  // errors. Validation throws before any fetch, so no network is hit here even
  // though a (dummy) key is configured.

  it('an unparseable endpoint exits 5 with a VALIDATION_ERROR naming endpoint-url', async () => {
    const result = await runCli(
      ['--output', 'json', '--endpoint-url', 'not a url', 'project', 'list'],
      { TESTSPRITE_API_KEY: 'sk-subproc' },
    );
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as { error: { code: string; nextAction: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.nextAction).toContain('endpoint-url');
  }, 30_000);

  it('a non-http(s) scheme exits 5 instead of being retried as a network failure', async () => {
    const result = await runCli(
      ['--output', 'json', '--endpoint-url', 'ftp://example.com', 'project', 'list'],
      { TESTSPRITE_API_KEY: 'sk-subproc' },
    );
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  }, 30_000);
});

describe('project get subprocess', () => {
  it('--output json returns the §6.1 Project shape', async () => {
    const result = await runCli(['--output', 'json', 'project', 'get', 'project_subproc'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe('project_subproc');
    expect(parsed.type).toBe('frontend');
    expect(parsed.createdFrom).toBe('portal');
  }, 30_000);

  it('text output prints the labeled fields block', async () => {
    const result = await runCli(['project', 'get', 'project_subproc'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('id:          project_subproc');
    expect(result.stdout).toContain('createdFrom: portal');
  }, 30_000);

  it('exits 4 (NOT_FOUND) for an unknown project id', async () => {
    const result = await runCli(['--output', 'json', 'project', 'get', 'project_does_not_exist'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(4);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('NOT_FOUND');
  }, 30_000);
});

describe('test list subprocess', () => {
  it('--output json returns the §6.2 TestList shape', async () => {
    const result = await runCli(
      ['--output', 'json', 'test', 'list', '--project', 'project_subproc'],
      {
        TESTSPRITE_API_KEY: 'sk-subproc',
        TESTSPRITE_API_URL: baseUrl,
      },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe('test_subproc');
    expect(parsed.items[0].status).toBe('failed');
    expect(parsed.nextToken).toBeNull();
  }, 30_000);

  it('--type frontend filter is forwarded to the facade', async () => {
    const result = await runCli(
      ['--output', 'json', 'test', 'list', '--project', 'project_subproc', '--type', 'frontend'],
      {
        TESTSPRITE_API_KEY: 'sk-subproc',
        TESTSPRITE_API_URL: baseUrl,
      },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items[0].type).toBe('frontend');
  }, 30_000);

  it('--type backend with no matching rows returns empty list', async () => {
    const result = await runCli(
      ['--output', 'json', 'test', 'list', '--project', 'project_subproc', '--type', 'backend'],
      {
        TESTSPRITE_API_KEY: 'sk-subproc',
        TESTSPRITE_API_URL: baseUrl,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).items).toEqual([]);
  }, 30_000);

  it('text output renders header + status column', async () => {
    const result = await runCli(['test', 'list', '--project', 'project_subproc'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ID');
    expect(result.stdout).toContain('STATUS');
    expect(result.stdout).toContain('Subproc test fixture');
    expect(result.stdout).toContain('failed');
  }, 30_000);

  it('--help prints filter and pagination flags', async () => {
    const result = await runCli(['test', 'list', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--project');
    expect(result.stdout).toContain('--type');
    expect(result.stdout).toContain('--created-from');
    expect(result.stdout).toContain('--page-size');
  }, 30_000);

  it('missing --project exits 5 with VALIDATION_ERROR (typed envelope)', async () => {
    const result = await runCli(['--output', 'json', 'test', 'list'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    // Per the CLI error spec §2 ("missing required field" → VALIDATION_ERROR)
    // and §6 (VALIDATION_ERROR → exit 5), so JSON consumers can branch on
    // `error.code` instead of a generic Commander exit-1 string.
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; details: { field: string } };
    };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.details.field).toBe('project');
  }, 30_000);

  it('--type=junk exits 5 with VALIDATION_ERROR (local validation)', async () => {
    const result = await runCli(
      ['--output', 'json', 'test', 'list', '--project', 'project_subproc', '--type', 'junk'],
      { TESTSPRITE_API_KEY: 'sk-subproc', TESTSPRITE_API_URL: baseUrl },
    );
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  }, 30_000);
});

describe('test get subprocess', () => {
  it('--output json returns the §6.2 Test shape', async () => {
    const result = await runCli(['--output', 'json', 'test', 'get', 'test_subproc'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe('test_subproc');
    expect(parsed.type).toBe('frontend');
    expect(parsed.status).toBe('failed');
  }, 30_000);

  it('text output prints the labeled fields block', async () => {
    const result = await runCli(['test', 'get', 'test_subproc'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('id:          test_subproc');
    expect(result.stdout).toContain('status:      failed');
    expect(result.stdout).toContain('createdFrom: portal');
  }, 30_000);

  it('exits 4 (NOT_FOUND) for an unknown test id', async () => {
    const result = await runCli(['--output', 'json', 'test', 'get', 'test_does_not_exist'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(4);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('NOT_FOUND');
  }, 30_000);
});

describe('test code get subprocess', () => {
  it('--output json returns the §6.3 TestCode shape', async () => {
    const result = await runCli(['--output', 'json', 'test', 'code', 'get', 'test_subproc'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      testId: string;
      language: string;
      framework: string;
      code: string;
      codeVersion: string;
    };
    expect(parsed.testId).toBe('test_subproc');
    expect(parsed.language).toBe('typescript');
    expect(parsed.framework).toBe('playwright');
    expect(parsed.codeVersion).toBe('v3');
  }, 30_000);

  it('text mode prints the inline source body without a JSON envelope', async () => {
    const result = await runCli(['test', 'code', 'get', 'test_subproc'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    // The source body itself must arrive on stdout, not the wire envelope.
    // Agents pipe `> file.ts` and expect a runnable file.
    expect(result.stdout).toContain("import { test } from '@playwright/test';");
    expect(result.stdout).not.toContain('"testId"');
    expect(result.stdout).not.toContain('"codeVersion"');
  }, 30_000);

  it('exits 4 (NOT_FOUND) for an unknown test id', async () => {
    const result = await runCli(
      ['--output', 'json', 'test', 'code', 'get', 'test_does_not_exist'],
      { TESTSPRITE_API_KEY: 'sk-subproc', TESTSPRITE_API_URL: baseUrl },
    );
    expect(result.exitCode).toBe(4);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('NOT_FOUND');
  }, 30_000);
});

describe('test steps subprocess', () => {
  it('--output json returns the §6.4 TestStepList shape', async () => {
    const result = await runCli(['--output', 'json', 'test', 'steps', 'test_subproc'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      items: Array<{ stepIndex: number; status: string | null; runIdIfAvailable: string | null }>;
      nextToken: string | null;
    };
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]!.stepIndex).toBe(1);
    expect(parsed.items[1]!.status).toBe('failed');
    // §6.4 atomicity: every step in one response shares runIdIfAvailable.
    const runIds = new Set(parsed.items.map(s => s.runIdIfAvailable));
    expect(runIds.size).toBe(1);
    expect(parsed.nextToken).toBeNull();
  }, 30_000);

  it('text mode renders the step table and shared run metadata', async () => {
    const result = await runCli(['test', 'steps', 'test_subproc'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('INDEX');
    expect(result.stdout).toContain('ACTION');
    expect(result.stdout).toContain('Click the cart icon');
    expect(result.stdout).toContain('Click the submit button');
    expect(result.stdout).toContain('runId:       run_subproc');
    expect(result.stdout).toContain('codeVersion: v3');
  }, 30_000);
});

describe('test result subprocess', () => {
  it('--output json returns the §6.5 LatestResult shape with correlation block', async () => {
    const result = await runCli(['--output', 'json', 'test', 'result', 'test_subproc'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      snapshotId: string;
      runIdIfAvailable: string | null;
      codeVersion: string | null;
      failedStepIndex: number | null;
      failureKind: string | null;
    };
    expect(parsed.status).toBe('failed');
    // §6.5: every correlation field is present (not omitted) so agents
    // can detect drift between code/result/steps.
    expect(parsed.snapshotId).toBe('snap_subproc');
    expect(parsed.runIdIfAvailable).toBe('run_subproc');
    expect(parsed.codeVersion).toBe('v3');
    expect(parsed.failedStepIndex).toBe(2);
    expect(parsed.failureKind).toBe('assertion');
  }, 30_000);

  it('text mode highlights failureKind + failedStepIndex above timestamps', async () => {
    const result = await runCli(['test', 'result', 'test_subproc'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split('\n');
    const kindLine = lines.findIndex(l => l.startsWith('failureKind'));
    const startedLine = lines.findIndex(l => l.startsWith('startedAt'));
    expect(kindLine).toBeGreaterThanOrEqual(0);
    expect(kindLine).toBeLessThan(startedLine);
    expect(result.stdout).toContain('failureKind:        assertion');
    expect(result.stdout).toContain('failedStepIndex:    2');
    expect(result.stdout).toContain('summary:            passed=1 failed=1 skipped=0');
  }, 30_000);
});

describe('auth remove subprocess', () => {
  it('removes the profile file entry and exits 0', async () => {
    // First configure a profile (via the consolidated `setup` path)
    const configureResult = await runCli(['setup', '--from-env', '--no-agent'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(configureResult.exitCode).toBe(0);

    const removeResult = await runCli(['auth', 'remove']);
    expect(removeResult.exitCode).toBe(0);
    expect(removeResult.stdout).toContain('Removed credentials');
  }, 30_000);
});

describe('setup --from-env subprocess', () => {
  it('writes the credentials file with mode 0600', async () => {
    const result = await runCli(['setup', '--from-env', '--no-agent'], {
      TESTSPRITE_API_KEY: 'sk-mode-test',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const credentialsPath = join(tmpHome, '.testsprite', 'credentials');
    expect(existsSync(credentialsPath)).toBe(true);
    expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
  }, 30_000);

  it('exits 5 with VALIDATION_ERROR when --from-env is set without TESTSPRITE_API_KEY', async () => {
    // Explicitly do not pass TESTSPRITE_API_KEY
    const result = await runCli(['setup', '--from-env', '--no-agent'], {
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain('TESTSPRITE_API_KEY');
  }, 30_000);
});

/**
 * P6 dry-run smoke. Each command must run end-to-end without an API
 * key, without network access (the local server is up but we never
 * point at it), and without writing to disk. Stdout is the canned
 * sample envelope; stderr carries the dry-run banner and any
 * "would write" annotations.
 */
describe('--dry-run subprocess smoke', () => {
  it('project list --dry-run returns canned ProjectList without auth', async () => {
    const result = await runCli(['project', 'list', '--dry-run', '--output', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { items: unknown[]; nextToken: null };
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.nextToken).toBeNull();
    expect(result.stderr).toContain('[dry-run] sample response');
  }, 30_000);

  it('project get --dry-run returns canned Project without auth', async () => {
    const result = await runCli([
      'project',
      'get',
      'proj_anything',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { id: string };
    expect(parsed.id).toBeTruthy();
  }, 30_000);

  it('test list --dry-run returns canned TestList', async () => {
    const result = await runCli([
      'test',
      'list',
      '--project',
      'proj_anything',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { items: unknown[] };
    expect(parsed.items.length).toBeGreaterThan(0);
  }, 30_000);

  it('test failure get --dry-run --out <dir> does NOT create the directory', async () => {
    const targetDir = join(tmpHome, 'dryrun-bundle-' + Date.now());
    expect(existsSync(targetDir)).toBe(false);
    const result = await runCli([
      'test',
      'failure',
      'get',
      'test_anything',
      '--dry-run',
      '--out',
      targetDir,
      '--output',
      'json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(targetDir)).toBe(false);
    expect(result.stderr).toContain('[dry-run] would write bundle to');
    expect(result.stderr).toContain(targetDir);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; dryRun: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
  }, 30_000);

  it('test failure get --dry-run --out <dir> text mode does not claim the bundle was written', async () => {
    // Stdout is the success contract — automation may parse it. The
    // real-mode renderer says "Bundle written to ..."; in dry-run that
    // would be a lie since the directory is never created. Codex flagged
    // this as a P2 in the first review of P6 piece-2; this test guards
    // against the regression.
    const targetDir = join(tmpHome, 'dryrun-bundle-text-' + Date.now());
    const result = await runCli([
      'test',
      'failure',
      'get',
      'test_anything',
      '--dry-run',
      '--out',
      targetDir,
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(targetDir)).toBe(false);
    expect(result.stdout).toMatch(/^\(dry-run\) would write bundle to /);
    expect(result.stdout).not.toContain('Bundle written to');
  }, 30_000);

  it('test code get --dry-run --out <file> does NOT create the file', async () => {
    const targetFile = join(tmpHome, 'dryrun-code-' + Date.now() + '.ts');
    expect(existsSync(targetFile)).toBe(false);
    const result = await runCli([
      'test',
      'code',
      'get',
      'test_anything',
      '--dry-run',
      '--out',
      targetFile,
      '--output',
      'json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(targetFile)).toBe(false);
    expect(result.stderr).toContain('[dry-run] would write code body');
    expect(result.stderr).toContain(targetFile);
  }, 30_000);

  it('auth configure --dry-run does NOT prompt and does NOT write credentials', async () => {
    // No TESTSPRITE_API_KEY in env; if dry-run actually called the prompt
    // path the subprocess would block waiting on stdin and the test would
    // time out. The fact that it exits 0 within the timeout proves it
    // skipped the prompt.
    const credPath = join(tmpHome, '.testsprite', 'credentials');
    // Make sure any previous test didn't leave one behind.
    if (existsSync(credPath)) execFileSync('rm', [credPath]);
    const result = await runCli(['setup', '--dry-run', '--no-agent', '--output', 'json']);
    expect(result.exitCode).toBe(0);
    expect(existsSync(credPath)).toBe(false);
    expect(result.stderr).toContain('[dry-run]');
    expect(result.stderr).toContain('would configure profile');
  }, 30_000);

  it('auth whoami --dry-run returns canned MeResponse without auth', async () => {
    const result = await runCli(['auth', 'status', '--dry-run', '--output', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { userId: string; scopes: string[] };
    expect(parsed.userId).toBeTruthy();
    expect(parsed.scopes.length).toBeGreaterThan(0);
  }, 30_000);

  it('auth logout --dry-run does NOT delete credentials', async () => {
    // First configure a real profile so there's something to (not) delete.
    await runCli(['setup', '--from-env', '--no-agent'], {
      TESTSPRITE_API_KEY: 'sk-keep-me',
      TESTSPRITE_API_URL: baseUrl,
    });
    const credPath = join(tmpHome, '.testsprite', 'credentials');
    expect(existsSync(credPath)).toBe(true);

    const result = await runCli(['auth', 'remove', '--dry-run']);
    expect(result.exitCode).toBe(0);
    expect(existsSync(credPath)).toBe(true);
    expect(result.stderr).toContain('[dry-run]');
    expect(result.stderr).toContain('would remove credentials');
  }, 30_000);
});

/**
 * Item-9 regression: `--dry-run` is a global flag for `test artifact get`.
 *
 * Three assertions per invocation:
 *   1. No credentials are read (no TESTSPRITE_API_KEY in env, no creds file
 *      on disk — exits 0, not 3).
 *   2. No HTTP call is made (the mock server is NOT pointed at; if the CLI
 *      made a real request it would either hang or fail, not exit 0 cleanly
 *      in time).
 *   3. No bundle directory is created under the cwd / --out path.
 *   4. Stdout is the canned success schema: { out, snapshotId, meta }.
 *
 * Two flag positions tested:
 *   a. `testsprite --dry-run test artifact get run_abc`  (global position)
 *   b. `testsprite test artifact get run_abc --dry-run`  (subcommand position)
 *      — before the fix, position (b) was silently coerced to `false` by
 *      the now-removed local `.option('--dry-run', ..., false)`.
 */
describe('test artifact get --dry-run subprocess (Item-9 regression)', () => {
  it('global --dry-run: no auth, no network, no disk write; stdout is canned schema', async () => {
    const targetDir = join(tmpHome, 'artifact-dryrun-global-' + Date.now());
    expect(existsSync(targetDir)).toBe(false);

    const result = await runCli([
      '--dry-run',
      '--output',
      'json',
      'test',
      'artifact',
      'get',
      'run_abc',
      '--out',
      targetDir,
    ]);

    expect(result.exitCode).toBe(0);
    // No directory created
    expect(existsSync(targetDir)).toBe(false);
    // Stdout is the canned success schema, not the old request envelope
    const parsed = JSON.parse(result.stdout) as {
      out: string;
      snapshotId: string;
      meta: Record<string, unknown>;
    };
    expect(parsed).toHaveProperty('out');
    expect(parsed).toHaveProperty('snapshotId');
    expect(parsed).toHaveProperty('meta');
    expect(parsed.meta).toHaveProperty('testId');
    expect(parsed.meta).toHaveProperty('projectId');
    // Old request-envelope keys must NOT appear
    expect(parsed).not.toHaveProperty('method');
    expect(parsed).not.toHaveProperty('path');
    expect(parsed).not.toHaveProperty('writeTo');
  }, 30_000);

  it('subcommand-positioned --dry-run: same guarantees as global', async () => {
    const targetDir = join(tmpHome, 'artifact-dryrun-subcmd-' + Date.now());
    expect(existsSync(targetDir)).toBe(false);

    const result = await runCli([
      '--output',
      'json',
      'test',
      'artifact',
      'get',
      'run_abc',
      '--out',
      targetDir,
      '--dry-run',
    ]);

    expect(result.exitCode).toBe(0);
    // No directory created — proves the flag was honoured, not silently
    // defaulted to false.
    expect(existsSync(targetDir)).toBe(false);
    const parsed = JSON.parse(result.stdout) as {
      out: string;
      snapshotId: string;
      meta: Record<string, unknown>;
    };
    expect(parsed).toHaveProperty('out');
    expect(parsed).toHaveProperty('snapshotId');
    expect(parsed).toHaveProperty('meta');
    expect(parsed).not.toHaveProperty('method');
    expect(parsed).not.toHaveProperty('writeTo');
  }, 30_000);

  it('text mode --dry-run: prints [dry-run] header without claiming bundle written', async () => {
    const targetDir = join(tmpHome, 'artifact-dryrun-text-' + Date.now());
    const result = await runCli([
      '--dry-run',
      'test',
      'artifact',
      'get',
      'run_abc',
      '--out',
      targetDir,
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(targetDir)).toBe(false);
    expect(result.stdout).toContain('[dry-run]');
    expect(result.stdout).toContain('GET');
    expect(result.stdout).not.toContain('Bundle written to');
  }, 30_000);
});

/**
 * [Fix 5] Commander argument/option parse errors → exit 5 (VALIDATION_ERROR family).
 *
 *   - Missing required argument  → exit 5
 *   - Unknown option             → exit 5 (was exit 1 via Commander default before this fix)
 *   - --help / -h                → exit 0  (user requested help — no error)
 *   - --version                  → exit 0  (user requested version — no error)
 */
describe('[fix-5] Commander parse errors → exit 5; help/version → exit 0', () => {
  it('`test result` with no test-id argument exits 5', async () => {
    const result = await runCli(['test', 'result'], {
      TESTSPRITE_API_KEY: 'sk-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    // Missing required argument is a VALIDATION_ERROR family error → exit 5.
    expect(result.exitCode).toBe(5);
    // Commander writes the error to stderr; it should mention the missing arg.
    expect(result.stderr).toContain('test-id');
  }, 30_000);

  it('`testsprite --help` exits 0', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('testsprite');
  }, 30_000);

  it('`testsprite test result --help` exits 0', async () => {
    const result = await runCli(['test', 'result', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('test-id');
  }, 30_000);

  it('`testsprite --version` exits 0', async () => {
    const result = await runCli(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBeTruthy(); // version string on stdout
  }, 30_000);
});
