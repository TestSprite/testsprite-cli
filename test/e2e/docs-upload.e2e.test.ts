/**
 * Local e2e for `project docs upload <file>` (DEV-384 piece V3-D).
 *
 * Spawns the real built binary (`dist/index.js`) against a single local HTTP
 * stub that plays BOTH sides of the three-step flow:
 *
 *   - the `/api/cli/v1` facade (mints the "presigned" URL, accepts register)
 *   - the presigned "S3" endpoint (receives the PUT)
 *
 * and asserts the contract end to end on the real fetch stack:
 *
 *   1. the exact file bytes arrive via PUT (byte-for-byte, 8 MiB fixture)
 *   2. the PUT uses identity framing (Content-Length, no chunked
 *      transfer-encoding — S3 rejects chunked presigned PUTs)
 *   3. the PUT never carries facade credentials
 *   4. the register call follows the PUT and echoes the minted s3Key
 *   5. step-2 vs step-3 failures exit (and read) differently
 *
 * No AWS, no creds, CI-runnable. Run via: `npm run test:e2e` (builds first).
 * Excluded from `npm test`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

const PROJECT_ID = 'proj_e2e_docs';
const API_KEY = 'sk-user-e2e-docs';

/** 8 MiB of deterministic binary content — every byte value occurs, incl. NUL. */
const FIXTURE_SIZE = 8 * 1024 * 1024;
function buildFixtureBytes(): Buffer {
  const buf = Buffer.allocUnsafe(FIXTURE_SIZE);
  for (let i = 0; i < FIXTURE_SIZE; i += 1) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

interface SeenRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

let server: Server;
let baseUrl = '';
/** Requests in arrival order, reset per test. */
let seen: SeenRequest[] = [];
/** Per-test overrides for the stub's responses. */
let putStatus = 200;
let registerStatus = 201;

beforeAll(async () => {
  if (!existsSync(BIN_PATH)) {
    throw new Error('dist/index.js not found — run `npm run test:e2e` which builds first.');
  }
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = (req.url ?? '').split('?')[0] ?? '';
      seen.push({ method: req.method ?? '', path, headers: req.headers, body });

      if (req.method === 'POST' && path.endsWith('/docs/upload-url')) {
        const parsed = JSON.parse(body.toString('utf8')) as { fileName: string };
        const s3Key = `u_e2e/${PROJECT_ID}/${parsed.fileName}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            uploadUrl: `${baseUrl}/s3/testsprite-usercontent/${s3Key}?X-Amz-Signature=e2e`,
            s3Key,
            expiresInSeconds: 3600,
          }),
        );
        return;
      }
      if (req.method === 'PUT' && path.startsWith('/s3/')) {
        if (putStatus !== 200) {
          res.writeHead(putStatus, { 'content-type': 'application/xml' });
          res.end('<Error><Code>AccessDenied</Code></Error>');
          return;
        }
        res.writeHead(200, { etag: '"e2e-etag"' });
        res.end();
        return;
      }
      if (req.method === 'POST' && path.endsWith('/docs')) {
        if (registerStatus !== 201) {
          res.writeHead(registerStatus, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'NOT_FOUND',
                message: 'Project not found.',
                nextAction: 'Check the project id.',
                requestId: 'req_e2e_docs_404',
                details: {},
              },
            }),
          );
          return;
        }
        const parsed = JSON.parse(body.toString('utf8')) as {
          displayName: string;
          docRole?: string;
        };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            resourceId: 'res_e2e_docs_1',
            displayName: parsed.displayName,
            docRole: parsed.docRole ?? null,
            processStatus: 'Pending',
          }),
        );
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: `unexpected ${path}` } }));
    });
  });
  await new Promise<void>(resolveListen => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>(resolveClose => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
});

afterEach(() => {
  seen = [];
  putStatus = 200;
  registerStatus = 201;
});

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function uploadViaCli(file: string, extraArgs: string[] = []): Promise<SpawnResult> {
  return new Promise<SpawnResult>(resolveRun => {
    const child = spawn(
      process.execPath,
      [
        BIN_PATH,
        'project',
        'docs',
        'upload',
        file,
        '--project',
        PROJECT_ID,
        '--output',
        'json',
        ...extraArgs,
      ],
      {
        env: {
          ...process.env,
          TESTSPRITE_API_KEY: API_KEY,
          TESTSPRITE_API_URL: baseUrl,
          TESTSPRITE_NO_SKILL_WARNING: '1',
          TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
          // The stub asserts the EXACT request list — keep telemetry out of it.
          TESTSPRITE_NO_TELEMETRY: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('exit', code => resolveRun({ code, stdout, stderr }));
  });
}

function makeFixtureFile(name: string, bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-docs-e2e-'));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe('docs upload e2e — three-step flow against a local facade + S3 stub', () => {
  it('DOCS-E2E-1: streams 8 MiB byte-for-byte via identity-framed PUT, then registers', async () => {
    const bytes = buildFixtureBytes();
    const file = makeFixtureFile('payload.bin', bytes);

    const result = await uploadViaCli(file);
    expect(result.code).toBe(0);

    // Exactly the three steps, in order.
    expect(seen.map(r => `${r.method} ${r.path}`)).toEqual([
      `POST /api/cli/v1/projects/${PROJECT_ID}/docs/upload-url`,
      `PUT /s3/testsprite-usercontent/u_e2e/${PROJECT_ID}/payload.bin`,
      `POST /api/cli/v1/projects/${PROJECT_ID}/docs`,
    ]);
    const [mint, put, register] = seen as [SeenRequest, SeenRequest, SeenRequest];

    // Step 1 declares name + MIME type and carries the facade key.
    expect(JSON.parse(mint.body.toString('utf8'))).toEqual({
      fileName: 'payload.bin',
      contentType: 'application/octet-stream',
    });
    expect(mint.headers['x-api-key']).toBe(API_KEY);

    // Step 2: identity framing (S3 rejects chunked presigned PUTs), the
    // exact bytes, and no facade credentials on the S3 host.
    expect(put.headers['content-length']).toBe(String(FIXTURE_SIZE));
    expect(put.headers['transfer-encoding']).toBeUndefined();
    expect(put.headers['content-type']).toBe('application/octet-stream');
    expect(put.headers['x-api-key']).toBeUndefined();
    expect(put.headers['idempotency-key']).toBeUndefined();
    expect(put.body.length).toBe(FIXTURE_SIZE);
    expect(put.body.equals(bytes)).toBe(true);

    // Step 3 registers the exact minted key with role + display name.
    expect(JSON.parse(register.body.toString('utf8'))).toEqual({
      s3Key: `u_e2e/${PROJECT_ID}/payload.bin`,
      displayName: 'payload.bin',
      docRole: 'API_DOC',
    });
    expect(register.headers['x-api-key']).toBe(API_KEY);
    expect(register.headers['idempotency-key']).toMatch(/^cli-docs-upload-/);

    // stdout is the JSON result envelope.
    const printed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(printed).toMatchObject({
      resourceId: 'res_e2e_docs_1',
      displayName: 'payload.bin',
      role: 'API_DOC',
      size: FIXTURE_SIZE,
      processStatus: 'Pending',
    });
  }, 60_000);

  it('DOCS-E2E-2: presigned PUT failure → exit 10, step-2 wording, register never fires', async () => {
    putStatus = 403;
    const file = makeFixtureFile('openapi.yaml', Buffer.from('openapi: 3.1.0\n'));

    const result = await uploadViaCli(file);
    expect(result.code).toBe(10);
    expect(result.stderr).toContain('step 2 of 3');
    expect(result.stderr).toMatch(/re-run/i);
    expect(seen.map(r => r.method)).toEqual(['POST', 'PUT']);
  }, 30_000);

  it('DOCS-E2E-3: register failure → server exit code (4), step-3 wording, PUT already happened', async () => {
    registerStatus = 404;
    const file = makeFixtureFile('openapi.yaml', Buffer.from('openapi: 3.1.0\n'));

    const result = await uploadViaCli(file);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('step 3 of 3');
    expect(result.stderr).toMatch(/upload succeeded|succeeded/i);
    expect(seen.map(r => r.method)).toEqual(['POST', 'PUT', 'POST']);
  }, 30_000);

  it('DOCS-E2E-4: --dry-run makes zero requests and prints the plan', async () => {
    const file = makeFixtureFile('openapi.yaml', Buffer.from('openapi: 3.1.0\n'));

    const result = await uploadViaCli(file, ['--dry-run']);
    expect(result.code).toBe(0);
    expect(seen).toHaveLength(0);

    const printed = JSON.parse(result.stdout) as { dryRun: boolean; steps: string[] };
    expect(printed.dryRun).toBe(true);
    expect(printed.steps).toHaveLength(3);
  }, 30_000);
});
