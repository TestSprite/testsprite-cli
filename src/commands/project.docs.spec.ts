/**
 * Unit tests for `project docs upload <file>` (DEV-384 piece V3-D).
 *
 * The command drives the three-step presigned-S3 flow against the V3-A facade:
 *   1. POST /projects/{id}/docs/upload-url  → { uploadUrl, s3Key, expiresInSeconds }
 *   2. HTTP PUT the file bytes to uploadUrl (streamed, never buffered)
 *   3. POST /projects/{id}/docs             → { resourceId, displayName, docRole, processStatus }
 *
 * Everything here runs against an injected fetchImpl — no network, no creds.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, InterruptError, RequestTimeoutError } from '../lib/errors.js';
import { ShutdownController } from '../lib/interrupt.js';
import { resetDryRunBannerForTesting } from '../lib/client-factory.js';
import { createProjectCommand, runDocsUpload } from './project.js';

const PROJECT_ID = 'proj_docs_1';
const S3_KEY = `u1/${PROJECT_ID}/openapi.json`;
const UPLOAD_URL = 'http://s3.local.test/bucket/u1/proj_docs_1/openapi.json?X-Amz-Signature=sig1';

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-docs-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- `dir` is this test's own mkdtempSync-created temp dir, not user input.
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- credentials fixture written into the same mkdtempSync temp dir, not user input.
  writeFileSync(
    credentialsPath,
    `[default]\napi_url = http://localhost:13501\napi_key = sk-user-docs\n`,
    { mode: 0o600 },
  );
  return { credentialsPath };
}

/** Write a fixture file with known bytes and return its path + content. */
function makeFile(name: string, content: string | Buffer): { path: string; bytes: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-docs-file-'));
  const path = join(dir, name);
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- upload fixture written into this helper's own mkdtempSync temp dir, not user input.
  writeFileSync(path, bytes);
  return { path, bytes };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Facade JSON bodies arrive as strings; the S3 PUT arrives as a stream. */
  bodyText?: string;
  bodyIsStream: boolean;
  duplex?: string;
  /** The `redirect` mode the caller set (PUT leg guards against 3xx hops). */
  redirect?: string;
  /** Bytes collected from a streamed body (PUT leg only). */
  streamedBytes?: Buffer;
}

interface StubOverrides {
  uploadUrlResponse?: () => Response | Promise<Response>;
  putResponse?: (init: RequestInit) => Response | Promise<Response>;
  registerResponse?: (bodyText: string) => Response | Promise<Response>;
}

/**
 * Router-style fetch mock: answers the two facade routes and the presigned
 * "S3" PUT, recording every call (method, headers, body form) in order.
 */
function makeDocsFetch(overrides: StubOverrides = {}): {
  fetchImpl: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const headers = Object.fromEntries(
      new Headers((init.headers ?? {}) as Record<string, string>).entries(),
    );
    const record: RecordedCall = {
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      bodyIsStream: init.body instanceof ReadableStream,
      duplex: (init as { duplex?: string }).duplex,
      redirect: (init as { redirect?: string }).redirect,
    };
    if (typeof init.body === 'string') record.bodyText = init.body;
    if (init.body instanceof ReadableStream) {
      record.streamedBytes = Buffer.from(await new Response(init.body).arrayBuffer());
    }
    calls.push(record);

    if (record.method === 'POST' && url.includes('/docs/upload-url')) {
      if (overrides.uploadUrlResponse) return overrides.uploadUrlResponse();
      return jsonResponse(200, {
        uploadUrl: UPLOAD_URL,
        s3Key: S3_KEY,
        expiresInSeconds: 3600,
      });
    }
    if (record.method === 'PUT') {
      if (overrides.putResponse) return overrides.putResponse(init);
      return new Response('', { status: 200 });
    }
    if (record.method === 'POST' && url.includes('/docs')) {
      if (overrides.registerResponse) return overrides.registerResponse(record.bodyText ?? '');
      const body = JSON.parse(record.bodyText ?? '{}') as {
        displayName?: string;
        docRole?: string;
      };
      return jsonResponse(201, {
        resourceId: 'res_docs_1',
        displayName: body.displayName,
        docRole: body.docRole ?? null,
        processStatus: 'Pending',
      });
    }
    throw new Error(`unexpected request in docs stub: ${record.method} ${url}`);
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface CapturedIo {
  stdoutLines: string[];
  stderrLines: string[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function captureIo(): CapturedIo {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout: line => stdoutLines.push(line),
    stderr: line => stderrLines.push(line),
  };
}

type DocsUploadOpts = Parameters<typeof runDocsUpload>[0];

function baseOpts(overrides: Record<string, unknown> = {}): DocsUploadOpts {
  return {
    profile: 'default',
    output: 'json' as const,
    debug: false,
    verbose: false,
    dryRun: false,
    projectId: PROJECT_ID,
    ...overrides,
  } as DocsUploadOpts;
}

describe('runDocsUpload — three-step flow', () => {
  it('runs upload-url → streamed PUT → register in order with default role api-doc', async () => {
    const { credentialsPath } = makeCreds();
    const { path, bytes } = makeFile('openapi.json', '{"openapi":"3.1.0"}');
    const { fetchImpl, calls } = makeDocsFetch();
    const io = captureIo();

    const result = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(calls.map(c => c.method)).toEqual(['POST', 'PUT', 'POST']);
    const [mint, put, register] = calls as [RecordedCall, RecordedCall, RecordedCall];
    expect(mint.url).toContain(`/projects/${PROJECT_ID}/docs/upload-url`);
    expect(put.url).toBe(UPLOAD_URL);
    expect(register.url).toContain(`/projects/${PROJECT_ID}/docs`);
    expect(register.url).not.toContain('upload-url');

    // Step 1 mints the key for the file's basename and declares the MIME type.
    expect(JSON.parse(mint.bodyText ?? '{}')).toEqual({
      fileName: 'openapi.json',
      contentType: 'application/json',
    });

    // Step 3 registers the exact key from step 1 with the mapped role.
    expect(JSON.parse(register.bodyText ?? '{}')).toEqual({
      s3Key: S3_KEY,
      displayName: 'openapi.json',
      docRole: 'API_DOC',
    });

    expect(result).toMatchObject({
      resourceId: 'res_docs_1',
      displayName: 'openapi.json',
      role: 'API_DOC',
      size: bytes.length,
      processStatus: 'Pending',
    });

    // JSON parity on stdout.
    const printed = JSON.parse(io.stdoutLines.join('\n')) as Record<string, unknown>;
    expect(printed.resourceId).toBe('res_docs_1');
    expect(printed.size).toBe(bytes.length);
  });

  it('streams the file bytes to the presigned URL (stream body, exact bytes, content-length)', async () => {
    const { credentialsPath } = makeCreds();
    // Binary content incl. NUL bytes so fidelity failures cannot hide.
    const payload = Buffer.concat([Buffer.from('spec-bytes\0\x01\x02'), Buffer.alloc(4096, 7)]);
    const { path, bytes } = makeFile('openapi.json', payload);
    const { fetchImpl, calls } = makeDocsFetch();
    const io = captureIo();

    await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    const put = calls[1]!;
    expect(put.bodyIsStream).toBe(true); // never a Buffer/string — no full-file buffering
    expect(put.duplex).toBe('half');
    expect(put.headers['content-length']).toBe(String(bytes.length));
    expect(put.headers['content-type']).toBe('application/json');
    expect(put.streamedBytes?.equals(bytes)).toBe(true);
  });

  it('never leaks facade credentials or idempotency headers to the presigned host', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('spec.yaml', 'openapi: 3.1.0');
    const { fetchImpl, calls } = makeDocsFetch();
    const io = captureIo();

    await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    // Facade calls carry the key; the S3 PUT must not.
    const [mint, put, register] = calls as [RecordedCall, RecordedCall, RecordedCall];
    expect(mint.headers['x-api-key']).toBe('sk-user-docs');
    expect(put.headers['x-api-key']).toBeUndefined();
    expect(put.headers['idempotency-key']).toBeUndefined();
    expect(register.headers['x-api-key']).toBe('sk-user-docs');
    expect(register.headers['idempotency-key']).toMatch(/^cli-docs-upload-/);
  });

  it('maps --role prd to PRD and honors --name for the display name', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('requirements.md', '# PRD');
    const { fetchImpl, calls } = makeDocsFetch();

    const io = captureIo();
    const result = await runDocsUpload(
      baseOpts({ file: path, role: 'prd', name: 'Checkout PRD v2' }),
      { credentialsPath, fetchImpl, stdout: io.stdout, stderr: io.stderr },
    );

    expect(JSON.parse(calls[2]!.bodyText ?? '{}')).toMatchObject({
      displayName: 'Checkout PRD v2',
      docRole: 'PRD',
    });
    expect(result).toMatchObject({ displayName: 'Checkout PRD v2', role: 'PRD' });
  });

  it('declares the MIME type by extension (yaml → application/yaml) on step 1 and the PUT', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.yaml', 'openapi: 3.1.0');
    const { fetchImpl, calls } = makeDocsFetch();
    const io = captureIo();

    await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(JSON.parse(calls[0]!.bodyText ?? '{}')).toMatchObject({
      contentType: 'application/yaml',
    });
    expect(calls[1]!.headers['content-type']).toBe('application/yaml');
  });
});

describe('runDocsUpload — failure modes are distinguished', () => {
  it('presigned PUT failure (step 2) → exit 10 with a re-mint hint; register never fires', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{}1');
    const { fetchImpl, calls } = makeDocsFetch({
      putResponse: () =>
        new Response('<Error><Code>AccessDenied</Code><Message>expired</Message></Error>', {
          status: 403,
        }),
    });

    const io = captureIo();
    const err = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('UNAVAILABLE');
    expect(apiErr.exitCode).toBe(10);
    const text = `${apiErr.message} ${apiErr.nextAction ?? ''}`;
    expect(text).toContain('step 2 of 3');
    expect(text).toMatch(/re-run/i);
    expect(text).toMatch(/expire/i);
    // `reason` is the discriminator callers branch on: it separates a failed
    // upload (nothing registered, re-run mints a fresh URL) from a failed
    // registration (the bytes already landed, re-running is safe).
    expect(apiErr.details.reason).toBe('presigned_put_failed');
    expect(apiErr.requestId).toBe('local');
    // The register call must NOT have happened after a failed upload.
    expect(calls.map(c => c.method)).toEqual(['POST', 'PUT']);
  });

  it('network-level throw during the PUT (undici-style TypeError with cause) → exit 10, reason presigned_put_failed', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{}4');
    // undici wraps network failures as `TypeError: fetch failed` with the
    // useful detail on `.cause` — the message must surface both.
    const { fetchImpl, calls } = makeDocsFetch({
      putResponse: () =>
        Promise.reject(
          Object.assign(new TypeError('fetch failed'), {
            cause: new Error('getaddrinfo ENOTFOUND s3.local.test'),
          }),
        ),
    });

    const io = captureIo();
    const err = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('UNAVAILABLE');
    expect(apiErr.exitCode).toBe(10);
    expect(apiErr.details.reason).toBe('presigned_put_failed');
    expect(apiErr.message).toContain('step 2 of 3');
    // describeCause formatting: wrapper message + nested cause in parentheses.
    expect(apiErr.message).toContain('fetch failed (getaddrinfo ENOTFOUND s3.local.test)');
    // The register call must NOT have happened after a failed upload.
    expect(calls.map(c => c.method)).toEqual(['POST', 'PUT']);
  });

  it('register failure (step 3) keeps the server error but says the upload already succeeded', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{}2');
    const { fetchImpl, calls } = makeDocsFetch({
      registerResponse: () =>
        jsonResponse(404, {
          error: {
            code: 'NOT_FOUND',
            message: 'Project not found.',
            nextAction: 'Check the project id.',
            requestId: 'req_reg_404',
            details: { projectId: PROJECT_ID },
          },
        }),
    });

    const io = captureIo();
    const err = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('NOT_FOUND'); // server envelope code/exit preserved
    expect(apiErr.exitCode).toBe(4);
    // registerStepError exists to keep these: the server's requestId, details,
    // and HTTP status must survive the rethrown (re-worded) envelope verbatim.
    expect(apiErr.requestId).toBe('req_reg_404');
    expect(apiErr.details).toEqual({ projectId: PROJECT_ID });
    expect(apiErr.httpStatus).toBe(404);
    const text = `${apiErr.message} ${apiErr.nextAction ?? ''}`;
    expect(text).toContain('step 3 of 3');
    expect(text).toMatch(/upload .*succeeded|succeeded.*upload/i);
    expect(calls.map(c => c.method)).toEqual(['POST', 'PUT', 'POST']);
  });

  it('a stalled PUT hits the per-request timeout → RequestTimeoutError (exit 7)', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{}3');
    const { fetchImpl } = makeDocsFetch({
      putResponse: init =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
          );
        }),
    });

    const io = captureIo();
    const err = await runDocsUpload(baseOpts({ file: path, requestTimeoutMs: 50 }), {
      credentialsPath,
      fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as RequestTimeoutError).exitCode).toBe(7);
  });

  it('a stalled REGISTER times out with the step-3 upload-succeeded context, still exit 7 (F4)', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{}4');
    let registerSignal: AbortSignal | undefined;
    const { fetchImpl, calls } = makeDocsFetch({
      registerResponse: () =>
        new Promise<Response>((_resolve, reject) => {
          // Stall until HttpClient's own per-request timer aborts — it then
          // classifies the abort as RequestTimeoutError.
          registerSignal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
          );
        }),
    });
    const baseFetch = fetchImpl;
    const spyFetch = (async (input: unknown, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      const url = typeof input === 'string' ? input : (input as { url: string }).url;
      if (method === 'POST' && url.includes('/docs') && !url.includes('upload-url')) {
        registerSignal = init.signal ?? undefined;
      }
      return baseFetch(input as Parameters<typeof baseFetch>[0], init);
    }) as typeof globalThis.fetch;

    const io = captureIo();
    const err = await runDocsUpload(baseOpts({ file: path, requestTimeoutMs: 1000 }), {
      credentialsPath,
      fetchImpl: spyFetch,
      stdout: io.stdout,
      stderr: io.stderr,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as RequestTimeoutError).exitCode).toBe(7);
    // The step-3 context must survive: upload landed, re-running is safe.
    expect((err as RequestTimeoutError).message).toContain('step 3 of 3');
    expect((err as RequestTimeoutError).message).toMatch(/upload succeeded/i);
    expect((err as RequestTimeoutError).message).toMatch(/re-running the whole command/i);
    // The PUT really happened before the register stalled.
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  });

  it('Ctrl-C during the PUT aborts it and surfaces InterruptError, not a timeout (F14b)', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{}6');
    const shutdown = new ShutdownController();
    const { fetchImpl } = makeDocsFetch({
      putResponse: init =>
        new Promise<Response>((_resolve, reject) => {
          // Simulate the signal arriving mid-upload; the composed signal must
          // abort the fetch (reject with the abort reason, like undici does).
          init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
          shutdown.interrupt('SIGINT');
        }),
    });

    const io = captureIo();
    const err = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
      shutdown,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InterruptError);
    expect(err).not.toBeInstanceOf(RequestTimeoutError);
  });

  it('an already-interrupted shutdown controller aborts the PUT immediately (F14b)', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{}7');
    const shutdown = new ShutdownController();
    shutdown.interrupt('SIGTERM');
    const { fetchImpl, calls } = makeDocsFetch({
      putResponse: init =>
        new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted) {
            reject((init.signal as AbortSignal).reason);
            return;
          }
          // Would hang forever otherwise — the pre-aborted signal must fire.
        }),
    });

    const err = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      shutdown,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(InterruptError);
    // The mint happened; the PUT was reached with an already-aborted signal.
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  });

  it('with only TESTSPRITE_REQUEST_TIMEOUT_MS set (no flag), a stalled PUT times out at the env value', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{}5');
    const { fetchImpl } = makeDocsFetch({
      putResponse: init =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
          );
        }),
    });

    const io = captureIo();
    // No requestTimeoutMs in opts — only the env var, via the injected env dep
    // (the same env `makeClient`/`makeHttpClient` resolve from). 1000 ms is the
    // clamp minimum, so it passes through unclamped.
    const err = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      env: { TESTSPRITE_REQUEST_TIMEOUT_MS: '1000' },
      stdout: io.stdout,
      stderr: io.stderr,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestTimeoutError);
    const timeoutErr = err as RequestTimeoutError;
    expect(timeoutErr.exitCode).toBe(7);
    // Proves the env var reached the PUT leg: the flag-less default is 120 000.
    expect(timeoutErr.timeoutMs).toBe(1000);
  });
});

describe('runDocsUpload — text output', () => {
  it('prints the uploaded card and the processing note with --output text', async () => {
    const { credentialsPath } = makeCreds();
    const { path, bytes } = makeFile('openapi.json', '{"openapi":"3.1.0"}');
    const { fetchImpl } = makeDocsFetch();
    const io = captureIo();

    await runDocsUpload(baseOpts({ file: path, output: 'text' }), {
      credentialsPath,
      fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    const text = io.stdoutLines.join('\n');
    expect(text).toContain(`uploaded openapi.json (${bytes.length} B) — processing started`);
    expect(text).toMatch(/generation can use this source once processing and embedding finish/);
    expect(text).toContain('testsprite test plan generate');
    // Text mode must not print JSON on stdout.
    expect(text).not.toContain('"resourceId"');
  });
});

describe('runDocsUpload — local validation (exit 5, zero network)', () => {
  async function expectLocalRejection(
    opts: Record<string, unknown>,
    messagePattern: RegExp,
  ): Promise<void> {
    const { credentialsPath } = makeCreds();
    const { fetchImpl, calls } = makeDocsFetch();
    const err = await runDocsUpload(baseOpts(opts), {
      credentialsPath,
      fetchImpl,
      // Deterministic env so the host's TESTSPRITE_PROJECT_ID never leaks in.
      env: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.exitCode).toBe(5);
    expect(`${apiErr.message} ${apiErr.nextAction ?? ''}`).toMatch(messagePattern);
    expect(calls).toHaveLength(0);
  }

  it('missing file → exit 5', async () => {
    await expectLocalRejection(
      { file: join(tmpdir(), 'definitely-not-there-xyz.json') },
      /does not exist|not found|no such file/i,
    );
  });

  it('empty file → exit 5', async () => {
    const { path } = makeFile('empty.json', '');
    await expectLocalRejection({ file: path }, /empty/i);
  });

  it('directory instead of a file → exit 5', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-docs-dir-'));
    await expectLocalRejection({ file: dir }, /not a (regular )?file|directory/i);
  });

  it('invalid --role → exit 5 naming the two accepted values', async () => {
    const { path } = makeFile('openapi.json', '{}');
    await expectLocalRejection({ file: path, role: 'spec' }, /api-doc.*prd|prd.*api-doc/i);
  });

  it('missing --project → exit 5 naming the env var', async () => {
    const { path } = makeFile('openapi.json', '{}');
    await expectLocalRejection(
      { file: path, projectId: undefined },
      /--project.*TESTSPRITE_PROJECT_ID/s,
    );
  });

  // DEV-384 review F5 — docs upload must honor TESTSPRITE_PROJECT_ID like
  // every other command.
  it('picks up TESTSPRITE_PROJECT_ID when --project is absent', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{"openapi":"3.1.0"}');
    const { fetchImpl, calls } = makeDocsFetch();
    const result = await runDocsUpload(baseOpts({ file: path, projectId: undefined }), {
      credentialsPath,
      fetchImpl,
      env: { TESTSPRITE_PROJECT_ID: 'proj_from_env' },
    });
    expect((result as { resourceId: string }).resourceId).toBe('res_docs_1');
    expect(calls[0]!.url).toContain('/projects/proj_from_env/docs/upload-url');
  });

  it('--project wins over TESTSPRITE_PROJECT_ID', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{"openapi":"3.1.0"}');
    const { fetchImpl, calls } = makeDocsFetch();
    await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      env: { TESTSPRITE_PROJECT_ID: 'proj_from_env' },
    });
    expect(calls[0]!.url).toContain(`/projects/${PROJECT_ID}/docs/upload-url`);
  });

  it('--name longer than 255 chars → exit 5', async () => {
    const { path } = makeFile('openapi.json', '{}');
    await expectLocalRejection({ file: path, name: 'x'.repeat(256) }, /255/);
  });

  it('non-ASCII --idempotency-key → exit 5', async () => {
    const { path } = makeFile('openapi.json', '{}');
    await expectLocalRejection({ file: path, idempotencyKey: 'clé-docs' }, /idempotency/i);
  });
});

describe('runDocsUpload — presigned-URL guard (DEV-384 review F3)', () => {
  /** Creds pointing at a REMOTE facade (the guard is active). */
  function makeRemoteCreds(): { credentialsPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cli-docs-remote-'));
    const credentialsPath = join(dir, 'credentials');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test's own mkdtempSync temp dir, not user input.
    mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- credentials fixture in the same temp dir, not user input.
    writeFileSync(
      credentialsPath,
      `[default]\napi_url = https://api.example.com\napi_key = sk-user-docs\n`,
      { mode: 0o600 },
    );
    return { credentialsPath };
  }

  async function expectMintRejected(mintedUrl: string): Promise<void> {
    const { credentialsPath } = makeRemoteCreds();
    const { path } = makeFile('openapi.json', '{"openapi":"3.1.0"}');
    const { fetchImpl, calls } = makeDocsFetch({
      uploadUrlResponse: () =>
        jsonResponse(200, { uploadUrl: mintedUrl, s3Key: S3_KEY, expiresInSeconds: 3600 }),
    });
    const err = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      env: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(5);
    expect((err as ApiError).message).toMatch(/presigned upload URL/i);
    // The PUT never fired — only the mint call reached the wire.
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0);
  }

  it('remote facade + localhost mint → rejected before any bytes are sent', async () => {
    await expectMintRejected('https://127.0.0.1/bucket/key?X-Amz-Signature=s');
  });

  it('remote facade + plain-http mint → rejected', async () => {
    await expectMintRejected('http://bucket.s3.amazonaws.com/key?X-Amz-Signature=s');
  });

  it('remote facade + private-IP mint → rejected', async () => {
    await expectMintRejected('https://10.0.0.8/bucket/key?X-Amz-Signature=s');
  });

  // #342 review: NAT64 is the metadata IP through the RFC 6052 prefix — the
  // shared classifier must catch it here too, not just on --target-url.
  it('remote facade + NAT64 metadata mint → rejected', async () => {
    await expectMintRejected('https://[64:ff9b::a9fe:a9fe]/bucket/key?X-Amz-Signature=s');
  });

  // #342 review: the trust gate is positive and fail-closed. A facade the
  // classifier merely DISLIKES (private-range endpoint, unparsable base URL)
  // must leave the guard ON — only an explicitly-loopback facade disables it.
  async function expectGuardStillOnFor(facadeApiUrl: string): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'cli-docs-oddfacade-'));
    const credentialsPath = join(dir, 'credentials');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test's own mkdtempSync temp dir, not user input.
    mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- credentials fixture in the same temp dir, not user input.
    writeFileSync(
      credentialsPath,
      `[default]\napi_url = ${facadeApiUrl}\napi_key = sk-user-docs\n`,
      {
        mode: 0o600,
      },
    );
    const { path } = makeFile('openapi.json', '{"openapi":"3.1.0"}');
    const { fetchImpl, calls } = makeDocsFetch({
      uploadUrlResponse: () =>
        jsonResponse(200, {
          uploadUrl: 'https://127.0.0.1/bucket/key?X-Amz-Signature=s',
          s3Key: S3_KEY,
          expiresInSeconds: 3600,
        }),
    });
    const err = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      env: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(5);
    expect((err as ApiError).message).toMatch(/presigned upload URL/i);
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0);
  }

  it('private-range facade (--endpoint-url https://10.1.2.3) + localhost mint → guard stays ON', async () => {
    await expectGuardStillOnFor('https://10.1.2.3');
  });

  // #342 review: an unparsable facade base URL must never fail OPEN. In the
  // real flow it fails even earlier than the guard (the mint request can't be
  // built), so this pins the safety PROPERTY — the command errors and zero
  // bytes are ever PUT — rather than the specific layer that catches it.
  it('unparsable facade base URL → command fails, nothing uploaded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-docs-badfacade-'));
    const credentialsPath = join(dir, 'credentials');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test's own mkdtempSync temp dir, not user input.
    mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- credentials fixture in the same temp dir, not user input.
    writeFileSync(credentialsPath, `[default]\napi_url = not a url\napi_key = sk-user-docs\n`, {
      mode: 0o600,
    });
    const { path } = makeFile('openapi.json', '{"openapi":"3.1.0"}');
    const { fetchImpl, calls } = makeDocsFetch({
      uploadUrlResponse: () =>
        jsonResponse(200, {
          uploadUrl: 'https://127.0.0.1/bucket/key?X-Amz-Signature=s',
          s3Key: S3_KEY,
          expiresInSeconds: 3600,
        }),
    });
    const err = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      env: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0);
  });

  // #342 review: `[::1]` is the load-bearing bracket-inclusive hostname case —
  // isLoopbackFacade keys on host === '[::1]'. A dev rig on IPv6 loopback must
  // be trusted (guard skipped, local mint allowed).
  it('LOCAL [::1] facade + local mint → still allowed (guard skipped)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-docs-v6loopback-'));
    const credentialsPath = join(dir, 'credentials');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test's own mkdtempSync temp dir, not user input.
    mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- credentials fixture in the same temp dir, not user input.
    writeFileSync(
      credentialsPath,
      `[default]\napi_url = http://[::1]:13501\napi_key = sk-user-docs\n`,
      {
        mode: 0o600,
      },
    );
    const { path } = makeFile('openapi.json', '{"openapi":"3.1.0"}');
    const { fetchImpl, calls } = makeDocsFetch({
      uploadUrlResponse: () =>
        jsonResponse(200, {
          uploadUrl: 'http://127.0.0.1:9000/bucket/key?X-Amz-Signature=s',
          s3Key: S3_KEY,
          expiresInSeconds: 3600,
        }),
    });
    const result = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      env: {},
    });
    expect((result as { resourceId: string }).resourceId).toBe('res_docs_1');
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  });

  it('remote facade + normal https S3 mint → allowed', async () => {
    const { credentialsPath } = makeRemoteCreds();
    const { path } = makeFile('openapi.json', '{"openapi":"3.1.0"}');
    const { fetchImpl, calls } = makeDocsFetch({
      uploadUrlResponse: () =>
        jsonResponse(200, {
          uploadUrl: 'https://bucket.s3.amazonaws.com/key?X-Amz-Signature=s',
          s3Key: S3_KEY,
          expiresInSeconds: 3600,
        }),
    });
    const result = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      env: {},
    });
    expect((result as { resourceId: string }).resourceId).toBe('res_docs_1');
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  });

  it('LOCAL facade (dev rig / e2e) + local http mint → still allowed', async () => {
    // The default makeCreds() facade is http://localhost:13501 and the stub
    // mints http://s3.local.test/... — the deliberately-local rig must keep
    // working (this is the localhost e2e's exact shape).
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{"openapi":"3.1.0"}');
    const { fetchImpl, calls } = makeDocsFetch();
    const result = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      env: {},
    });
    expect((result as { resourceId: string }).resourceId).toBe('res_docs_1');
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  });

  // #342 review: the guard vets the MINTED url only; the PUT must refuse to
  // FOLLOW a redirect to an unvetted host. The mock ignores `redirect`, so a
  // 303-Response test would prove nothing (it just looks like a failed PUT) —
  // instead assert the init the CLI sent, and separately that a refused
  // redirect (undici throws a TypeError) maps to the existing
  // presigned_put_failed envelope with no new error reason.
  it('issues the PUT with redirect:"error" (no 3xx hop to an unvetted host)', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{"openapi":"3.1.0"}');
    const { fetchImpl, calls } = makeDocsFetch();
    await runDocsUpload(baseOpts({ file: path }), { credentialsPath, fetchImpl, env: {} });
    const put = calls.find(c => c.method === 'PUT');
    expect(put?.redirect).toBe('error');
  });

  it('a refused redirect on the PUT (TypeError) maps to presigned_put_failed (exit 10)', async () => {
    const { credentialsPath } = makeCreds();
    const { path } = makeFile('openapi.json', '{"openapi":"3.1.0"}');
    const { fetchImpl } = makeDocsFetch({
      // undici throws a TypeError ("fetch failed") when redirect:"error" hits a 3xx.
      putResponse: () => {
        throw new TypeError('fetch failed');
      },
    });
    const err = await runDocsUpload(baseOpts({ file: path }), {
      credentialsPath,
      fetchImpl,
      env: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(10);
    expect((err as ApiError).getDetail('reason')).toBe('presigned_put_failed');
  });
});

describe('runDocsUpload — dry-run (zero network, stat only)', () => {
  it('makes no fetch calls and prints the would-be three-step plan', async () => {
    resetDryRunBannerForTesting();
    const { credentialsPath } = makeCreds();
    const { path, bytes } = makeFile('openapi.yaml', 'openapi: 3.1.0\n');
    const { fetchImpl, calls } = makeDocsFetch();
    const io = captureIo();

    const result = await runDocsUpload(baseOpts({ file: path, dryRun: true, role: 'prd' }), {
      credentialsPath,
      fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    });

    expect(calls).toHaveLength(0); // zero network
    expect(result).toMatchObject({
      dryRun: true,
      projectId: PROJECT_ID,
      fileName: 'openapi.yaml',
      size: bytes.length,
      role: 'PRD',
    });

    const printed = JSON.parse(io.stdoutLines.join('\n')) as { steps?: string[] };
    expect(printed.steps).toHaveLength(3);
    expect(io.stderrLines.join('\n')).toMatch(/dry-run/i);
  });

  it('dry-run still fails fast on a missing file (stat is allowed)', async () => {
    const { credentialsPath } = makeCreds();
    const { fetchImpl, calls } = makeDocsFetch();
    const err = await runDocsUpload(
      baseOpts({ file: join(tmpdir(), 'nope-dry-run.json'), dryRun: true }),
      { credentialsPath, fetchImpl },
    ).catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(5);
    expect(calls).toHaveLength(0);
  });
});

describe('project docs upload — command wiring', () => {
  it('registers the docs sub-group with an upload leaf and the documented flags', () => {
    const project = createProjectCommand();
    const docs = project.commands.find(c => c.name() === 'docs');
    expect(docs).toBeDefined();
    const upload = docs!.commands.find(c => c.name() === 'upload');
    expect(upload).toBeDefined();
    const flagNames = upload!.options.map(o => o.long);
    expect(flagNames).toContain('--project');
    expect(flagNames).toContain('--role');
    expect(flagNames).toContain('--name');
    expect(flagNames).toContain('--idempotency-key');
    // The default role is a documented part of the contract.
    expect(upload!.helpInformation()).toMatch(/api-doc.*default|default.*api-doc/i);
  });
});
