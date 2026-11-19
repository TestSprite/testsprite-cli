import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, InterruptError, RequestTimeoutError } from '../errors.js';
import { HttpClient, type FetchImpl } from '../http.js';
import { ShutdownController } from '../interrupt.js';
import { conversationApi, type StorageUploadOptions } from './api.js';

const BASE = 'https://api.example.com/api/cli/v1';
const API_KEY = 'sk-user-abc';
const UPLOAD_URL = 'https://storage.example.com/uploads/notes.md?signature=abc';
const MINTED = { uploadUrl: UPLOAD_URL, name: 'notes.md' };
const FILE = {
  name: 'notes.md',
  contentType: 'text/markdown',
  bytes: new TextEncoder().encode('# notes'),
};
const CONVERSATION = '/projects/p1/conversations/c1';

interface Call {
  method: string;
  url: string;
  /** The API route, or the whole URL for a request that left the API. */
  route: string;
  init: RequestInit;
}

/** A fetch that records every request and answers it with what the test decides. */
function recorder(answer: (call: Call, nth: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: FetchImpl = async (input, init = {}) => {
    const url = String(input);
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      route: url.startsWith(BASE) ? url.slice(BASE.length) : url,
      init,
    };
    calls.push(call);
    return answer(call, calls.length);
  };
  return { calls, fetchImpl };
}

/** The API over the real HttpClient, so its retry rules are the ones under test. */
function apiOver(fetchImpl: FetchImpl, storage: Partial<StorageUploadOptions> = {}) {
  const client = new HttpClient({
    baseUrl: BASE,
    apiKey: API_KEY,
    fetchImpl,
    // The backoff between attempts, without the wait.
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  return conversationApi(client, fetchImpl, {
    requestTimeoutMs: 60_000,
    // Never the process-wide one: a test's Ctrl-C must stay its own.
    shutdown: new ShutdownController(),
    ...storage,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function failure(status: number, code: string): Response {
  return json(
    { error: { code, message: code, nextAction: 'Retry.', requestId: 'req_1', details: {} } },
    status,
  );
}

const PENDING = Symbol('pending');

/** Start work and keep its outcome where a test can look without waiting on it. */
function track(work: Promise<unknown>): { now: () => unknown } {
  let outcome: unknown = PENDING;
  work.then(
    value => {
      outcome = value;
    },
    (err: unknown) => {
      outcome = err;
    },
  );
  return { now: () => outcome };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * Storage that takes the request and never answers. Like fetch, it gives up
 * when the request's signal aborts, rejecting with what `rejection` picks.
 */
function silentStorage(rejection: (signal: AbortSignal) => unknown = signal => signal.reason) {
  let reach!: () => void;
  const reached = new Promise<void>(resolve => {
    reach = resolve;
  });
  const put = (call: Call): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      const signal = call.init.signal;
      signal?.addEventListener('abort', () => reject(rejection(signal)), { once: true });
      reach();
    });
  return { put, reached };
}

const SERVER_ERRORS = [
  [500, 'INTERNAL'],
  [503, 'UNAVAILABLE'],
] as const;

describe('a server error on a write that is safe to send twice', () => {
  it.each(SERVER_ERRORS)('sends stop again after a %d', async (status, code) => {
    const { calls, fetchImpl } = recorder((_call, nth) =>
      nth === 1 ? failure(status, code) : json({ ok: true }, 202),
    );

    await expect(apiOver(fetchImpl).stop('p1', 'c1')).resolves.toEqual({});

    expect(calls.map(c => `${c.method} ${c.route}`)).toEqual([
      `POST ${CONVERSATION}/stop`,
      `POST ${CONVERSATION}/stop`,
    ]);
  });

  it('says whether the stop found the agent at work', async () => {
    const { fetchImpl } = recorder(() => json({ ok: true, stopped: false }, 202));
    await expect(apiOver(fetchImpl).stop('p1', 'c1')).resolves.toEqual({ stopped: false });
  });

  it.each(SERVER_ERRORS)('sends discard again after a %d', async (status, code) => {
    const { calls, fetchImpl } = recorder((_call, nth) =>
      nth === 1 ? failure(status, code) : json({ discarded: 'c1', released: ['tests/a.md'] }),
    );

    await expect(apiOver(fetchImpl).discard('p1', 'c1')).resolves.toEqual({
      discarded: 'c1',
      released: ['tests/a.md'],
    });

    expect(calls.map(c => `${c.method} ${c.route}`)).toEqual([
      `POST ${CONVERSATION}/discard`,
      `POST ${CONVERSATION}/discard`,
    ]);
  });

  it.each(SERVER_ERRORS)(
    'asks for the upload URL again after a %d, then uploads once',
    async (status, code) => {
      const { calls, fetchImpl } = recorder((call, nth) => {
        if (call.method === 'PUT') return new Response(null, { status: 200 });
        return nth === 1 ? failure(status, code) : json(MINTED);
      });

      await expect(apiOver(fetchImpl).upload('p1', 'c1', FILE)).resolves.toBe('notes.md');

      expect(calls.map(c => `${c.method} ${c.route}`)).toEqual([
        `POST ${CONVERSATION}/files`,
        `POST ${CONVERSATION}/files`,
        `PUT ${UPLOAD_URL}`,
      ]);
    },
  );

  it('still takes a conflict on discard as the answer', async () => {
    const { calls, fetchImpl } = recorder(() => failure(409, 'CONFLICT'));

    await expect(apiOver(fetchImpl).discard('p1', 'c1')).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    expect(calls).toHaveLength(1);
  });
});

describe('the upload to storage', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up at the request timeout when storage never answers', async () => {
    // Only the timers the deadline runs on: the rest of the flow stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const storage = silentStorage();
    const { fetchImpl } = recorder(call =>
      call.method === 'PUT' ? storage.put(call) : json(MINTED),
    );

    const upload = track(apiOver(fetchImpl, { requestTimeoutMs: 30_000 }).upload('p1', 'c1', FILE));
    await storage.reached;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(upload.now()).toBe(PENDING);
    await vi.advanceTimersByTimeAsync(1);
    await tick();

    const err = upload.now();
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect(err).toMatchObject({ exitCode: 7, timeoutMs: 30_000 });
    // Says which step timed out, and still names both controls.
    expect((err as RequestTimeoutError).message).toMatch(/^Uploading notes\.md timed out/);
    expect((err as RequestTimeoutError).message).toContain('--request-timeout');
    expect((err as RequestTimeoutError).message).toContain('TESTSPRITE_REQUEST_TIMEOUT_MS');
  });

  /** An answer whose headers arrive and whose body then never ends. */
  function stalledAnswer(status: number) {
    const body = { cancelled: false };
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<Error><Code>AccessDenied</Code>'));
        },
        pull: () => new Promise<void>(() => undefined),
        cancel: () => {
          body.cancelled = true;
        },
      }),
      { status },
    );
    return { response, body };
  }

  // The deadline is a minute and the test has two seconds: waiting on the
  // body, even up to the deadline, fails it.
  it('reports a refusal at once and lets go of a body storage never finishes', async () => {
    const { response, body } = stalledAnswer(403);
    const { fetchImpl } = recorder(call => (call.method === 'PUT' ? response : json(MINTED)));

    const err: unknown = await apiOver(fetchImpl)
      .upload('p1', 'c1', FILE)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'UNAVAILABLE',
      exitCode: 10,
      message: 'Uploading notes.md failed: storage answered HTTP 403.',
      details: { reason: 'presigned_put_failed', file: 'notes.md' },
    });
    await tick();
    // Left unread and uncancelled, the body would hold the connection open.
    expect(body.cancelled).toBe(true);
  }, 2_000);

  it('lets go of the body of an accepted upload too', async () => {
    const { response, body } = stalledAnswer(200);
    const { fetchImpl } = recorder(call => (call.method === 'PUT' ? response : json(MINTED)));

    await expect(apiOver(fetchImpl).upload('p1', 'c1', FILE)).resolves.toBe('notes.md');

    await tick();
    expect(body.cancelled).toBe(true);
  }, 2_000);

  it.each([
    ['the abort reason, as fetch does', (signal: AbortSignal): unknown => signal.reason],
    [
      'a bare abort error',
      (): unknown => new DOMException('This operation was aborted', 'AbortError'),
    ],
  ])(
    'ends as an interrupt, not a timeout, when Ctrl-C arrives mid-upload (storage rejects with %s)',
    async (_name, rejection) => {
      const shutdown = new ShutdownController();
      const storage = silentStorage(rejection);
      const { fetchImpl } = recorder(call =>
        call.method === 'PUT' ? storage.put(call) : json(MINTED),
      );

      const upload = track(apiOver(fetchImpl, { shutdown }).upload('p1', 'c1', FILE));
      await storage.reached;
      // Armed while the PUT runs, or the signal handler would end the process
      // before the command could unwind.
      expect(shutdown.isArmed).toBe(true);
      shutdown.interrupt('SIGINT');
      await tick();

      const err = upload.now();
      expect(err).toBeInstanceOf(InterruptError);
      expect(err).not.toBeInstanceOf(RequestTimeoutError);
      expect(err).toMatchObject({ exitCode: 130 });
      expect(shutdown.isArmed).toBe(false);
    },
  );

  it('reports a connection that fails before storage answers as storage unavailable', async () => {
    const { fetchImpl } = recorder(call => {
      if (call.method === 'PUT') throw new TypeError('fetch failed');
      return json(MINTED);
    });

    const err = await apiOver(fetchImpl)
      .upload('p1', 'c1', FILE)
      .catch((e: unknown) => e);

    // Exit 10, not the uncaught exit 1 these commands use for "the agent stopped".
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'UNAVAILABLE',
      exitCode: 10,
      details: { reason: 'presigned_put_failed', file: 'notes.md' },
    });
    expect((err as ApiError).message).toContain('fetch failed');
  });

  it('sends the bytes to the minted URL without the API key and refuses redirects', async () => {
    const { calls, fetchImpl } = recorder(call =>
      call.method === 'PUT' ? new Response(null, { status: 200 }) : json(MINTED),
    );

    await expect(apiOver(fetchImpl).upload('p1', 'c1', FILE)).resolves.toBe('notes.md');

    const [mint, put] = calls as [Call, Call];
    // The API call carries the key, so its absence below means something.
    expect(mint.init.headers).toMatchObject({ 'x-api-key': API_KEY });
    expect(JSON.parse(mint.init.body as string)).toEqual({
      fileName: 'notes.md',
      contentType: 'text/markdown',
    });
    expect(put.url).toBe(UPLOAD_URL);
    expect(put.init.method).toBe('PUT');
    // Nothing but the content type: no authorization, no x-api-key.
    expect(put.init.headers).toEqual({ 'content-type': 'text/markdown' });
    expect(put.init.redirect).toBe('error');
    expect(put.init.body).toBe(FILE.bytes);
  });
});
