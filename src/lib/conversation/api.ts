import { randomUUID } from 'node:crypto';
import type { FetchImpl, HttpClient } from '../http.js';
import { ApiError, InterruptError, RequestTimeoutError } from '../errors.js';
import { globalShutdown, type ShutdownHandle } from '../interrupt.js';
import { assertSafePresignedUploadUrl } from '../presigned-url.js';
import type { ApplyResult, Brief, Conversation, ConversationSummary } from './types.js';
import type { PlanEnvironment } from './environment.js';

/** The longest a follow request may be held by the server, in seconds. */
export const MAX_WAIT_SECONDS = 25;

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/conversations`;
const one = (projectId: string, id: string) => `${base(projectId)}/${encodeURIComponent(id)}`;
const idempotent = () => ({ 'idempotency-key': randomUUID() });

export interface ConversationApi {
  /** The project's name, for saying which project a command took from the folder. */
  project(projectId: string): Promise<{ name: string }>;
  environments(projectId: string): Promise<PlanEnvironment[]>;
  start(
    projectId: string,
    options: { model?: string; title?: string },
  ): Promise<{ id: string; url: string; model: string }>;
  list(projectId: string, limit?: number): Promise<ConversationSummary[]>;
  get(
    projectId: string,
    id: string,
    follow?: { afterSeq: number; waitSeconds: number; signal?: AbortSignal },
  ): Promise<Conversation>;
  upload(
    projectId: string,
    id: string,
    file: { name: string; contentType: string; bytes: Uint8Array },
  ): Promise<string>;
  send(
    projectId: string,
    id: string,
    message: { text: string; files?: string[]; brief?: Brief },
  ): Promise<void>;
  /** Decides the card named, never whichever waits now; 409 when it was decided meanwhile. */
  apply(
    projectId: string,
    id: string,
    choice: {
      card: string;
      only?: string[];
      exclude?: string[];
      /** For a secret card: what a person typed. Never a flag, never stored by the CLI. */
      secrets?: { value: string };
      /** For a question card: the answer to each question, by the question's text. */
      answers?: Record<string, string>;
      /** For a run card: run on this environment instead of the one the card names, by name. */
      environment?: string;
    },
  ): Promise<ApplyResult>;
  reject(
    projectId: string,
    id: string,
    card: string,
    reason?: string,
  ): Promise<{ rejected: string }>;
  /** `stopped` is false when the agent was not at work; older servers leave it out. */
  stop(projectId: string, id: string): Promise<{ stopped?: boolean }>;
  /** Stop the agent, turn down a waiting card, and put back what it changed and never saved. */
  discard(projectId: string, id: string): Promise<{ discarded: string; released: string[] }>;
}

/**
 * What a file's PUT to storage needs from the caller. That request goes around
 * HttpClient, so it gets none of the client's deadline or Ctrl-C handling
 * unless it is handed the same two things.
 */
export interface StorageUploadOptions {
  /** The longest one file's PUT may take: the per-request timeout the API calls run under. */
  requestTimeoutMs: number;
  /** Where Ctrl-C arrives. The process-wide one unless a test hands in its own. */
  shutdown?: Pick<ShutdownHandle, 'signal' | 'arm'>;
}

export function conversationApi(
  client: HttpClient,
  fetchImpl: FetchImpl,
  storage: StorageUploadOptions,
): ConversationApi {
  return {
    project: projectId =>
      client.get<{ name: string }>(`/projects/${encodeURIComponent(projectId)}`),

    environments: async projectId =>
      (
        await client.get<{ environments: PlanEnvironment[] }>(
          `/projects/${encodeURIComponent(projectId)}/env`,
        )
      ).environments,

    start: (projectId, { model, title }) =>
      client.post(base(projectId), {
        body: {
          ...(model ? { model } : {}),
          ...(title ? { title } : {}),
        },
        headers: idempotent(),
      }),

    list: async (projectId, limit = 20) =>
      (
        await client.get<{ conversations: ConversationSummary[] }>(base(projectId), {
          query: { limit },
        })
      ).conversations,

    get: (projectId, id, follow) =>
      client.get<Conversation>(one(projectId, id), {
        query: follow
          ? { afterSeq: follow.afterSeq, waitSeconds: follow.waitSeconds || undefined }
          : {},
        signal: follow?.signal,
      }),

    async upload(projectId, id, file) {
      // The mint only signs a URL for a path fixed by the conversation and the
      // file name, and stores nothing, so asking again after a server error is
      // harmless.
      const minted = await client.post<{ uploadUrl: string; name: string }>(
        `${one(projectId, id)}/files`,
        { body: { fileName: file.name, contentType: file.contentType }, replaySafe: true },
      );
      assertSafePresignedUploadUrl(minted.uploadUrl, client.resolvedBaseUrl);
      await putToStorage(fetchImpl, minted.uploadUrl, file, storage);
      return minted.name;
    },

    async send(projectId, id, message) {
      await client.post(`${one(projectId, id)}/messages`, {
        body: message,
        headers: idempotent(),
        retryOnConflict: false,
      });
    },

    apply: (projectId, id, choice) =>
      client.post(`${one(projectId, id)}/apply`, {
        body: choice,
        headers: idempotent(),
        retryOnConflict: false,
      }),

    reject: (projectId, id, card, reason) =>
      client.post(`${one(projectId, id)}/reject`, {
        body: { card, ...(reason ? { reason } : {}) },
        headers: idempotent(),
        retryOnConflict: false,
      }),

    async stop(projectId, id) {
      // A second stop finds the agent already stopped and nothing left waiting,
      // so a server error is retried instead of failing the command, whose
      // exit 1 would read as "the agent stopped".
      const { stopped } = await client.post<{ stopped?: boolean }>(`${one(projectId, id)}/stop`, {
        body: {},
        replaySafe: true,
      });
      return typeof stopped === 'boolean' ? { stopped } : {};
    },

    // Safe to send again after a server error: a second discard finds the card
    // already turned down and the files already put back, and finishes whatever
    // the first one left undone.
    discard: (projectId, id) =>
      client.post(`${one(projectId, id)}/discard`, {
        body: {},
        retryOnConflict: false,
        replaySafe: true,
      }),
  };
}

function storageUnavailable(fileName: string, why: string): ApiError {
  return new ApiError({
    code: 'UNAVAILABLE',
    message: `Uploading ${fileName} failed: ${why}.`,
    nextAction: 'Nothing was sent to the agent. Run the command again.',
    requestId: 'local',
    details: { reason: 'presigned_put_failed', file: fileName },
  });
}

/**
 * PUT one file's bytes to the URL the server minted. Straight to storage,
 * never through HttpClient, so the API key isn't sent there. Going around the
 * client also means nothing else bounds this request: storage that stops
 * answering would hold the command for as long as the connection stays open.
 * So it gets the same per-request deadline as an API call (exit 7), and Ctrl-C
 * aborts it (exit 130/143).
 */
async function putToStorage(
  fetchImpl: FetchImpl,
  uploadUrl: string,
  file: { name: string; contentType: string; bytes: Uint8Array },
  { requestTimeoutMs, shutdown = globalShutdown }: StorageUploadOptions,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const shutdownSignal = shutdown.signal;
  const onShutdownAbort = (): void => controller.abort(shutdownSignal.reason);
  // Armed for as long as the PUT runs: the signal handler does not track this
  // request, and outside an armed scope it would end the process on the first
  // Ctrl-C without letting the command unwind.
  const disarm = shutdown.arm();
  if (shutdownSignal.aborted) onShutdownAbort();
  else shutdownSignal.addEventListener('abort', onShutdownAbort, { once: true });
  try {
    const response = await fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': file.contentType },
      body: file.bytes,
      // Only the minted URL was checked. Following a redirect would send the
      // file to an address nothing looked at.
      redirect: 'error',
      signal: controller.signal,
    } as RequestInit);
    // Only the status is used. Let go of the body without waiting for it, so
    // storage that stalls after its headers can't keep the connection, and
    // with it the process, open.
    void response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      throw storageUnavailable(file.name, `storage answered HTTP ${response.status}`);
    }
  } catch (cause) {
    // Ctrl-C outranks the deadline: both abort the same request, and an
    // interrupted upload must not be reported as a timeout.
    if (cause instanceof InterruptError) throw cause;
    if (shutdownSignal.aborted) throw shutdownSignal.reason;
    if (cause instanceof ApiError) throw cause;
    // Past the Ctrl-C checks, only the deadline can have aborted the request.
    if (controller.signal.aborted) {
      const timedOut = new RequestTimeoutError(requestTimeoutMs);
      timedOut.message = `Uploading ${file.name} timed out; nothing was sent to the agent. ${timedOut.message}`;
      throw timedOut;
    }
    // A connection that failed, or a redirect refused above, is storage being
    // unreachable, as a refusal is. Left raw it would end the command with
    // exit 1, which these commands use to mean "the agent stopped".
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw storageUnavailable(file.name, `network error before storage answered: ${reason}`);
  } finally {
    clearTimeout(timer);
    shutdownSignal.removeEventListener('abort', onShutdownAbort);
    disarm();
  }
}
