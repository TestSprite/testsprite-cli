/**
 * `--local <port>` argument handling and the pre-charge port probe.
 *
 * Separate from `target-url-preflight.ts` on purpose, even though both answer
 * "is the thing I am about to bill a run against actually there". They probe
 * two different mechanisms and must not share one:
 *
 *   - `--target-url` is fetched by a browser inside a Lambda, so probing it
 *     with `fetch()` (proxy dispatcher and all) is the closest local analogue,
 *     and an ambiguous result downgrades to a warning because the CLI is not
 *     the machine that will do the fetching.
 *   - `--local <port>` is dialled by the vendored tunnel client running *in
 *     this very process*, with `net.connect`, against the candidate set
 *     {@link resolveDialCandidates} produces. So the probe uses that same
 *     function and the same kind of socket. A pass means at least one TCP
 *     connection actually completed; every other result refuses. In
 *     particular, `ETIMEDOUT` can be a dropped SYN with no listener at all,
 *     so it is not evidence that something is bound. That is why this one is
 *     allowed to be the gate that runs BEFORE the mint and therefore before
 *     any run row or credit spend exists.
 */

import * as net from 'node:net';
import { ApiError, localValidationError } from './errors.js';
import { resolveDialCandidates } from '../vendor/tunnel-client/index.js';

/**
 * The loopback spellings a tunnel target may use.
 *
 * This is a MIRROR of the server's `isLoopbackString`
 * (backend-v2.0 `libs/net/private-address.ts`), which accepts exactly
 * `localhost`, `127.0.0.1` and `::1` — not "anything in 127.0.0.0/8". Keeping
 * the two identical is the whole point of validating client-side at all: a
 * value this accepts and the server rejects would fail with
 * `tunnel-target-not-local` AFTER a tunnel had already been minted, and a
 * value this rejects but the server accepts is a capability silently withheld.
 */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

/** Default `--local-host`. An IP literal, so no resolver is involved at all. */
export const DEFAULT_LOCAL_HOST: LoopbackHost = '127.0.0.1';

/**
 * Per-candidate dial budget. Deliberately short: this is a loopback connect on
 * the caller's own machine, where a live listener answers in microseconds. A
 * long budget would only lengthen the wait before an honest refusal.
 */
export const LOCAL_PORT_PROBE_TIMEOUT_MS = 2_000;

export type LocalPortProbeOutcome = { verdict: 'ok' } | { verdict: 'refuse'; reason: string };

export interface LocalPortProbeDeps {
  /**
   * Dial one candidate; resolve on connect, reject on failure. Defaults to a
   * real `net.connect`. Injectable so a test can prove the
   * `--skip-preflight` path makes ZERO attempts — the assertion that matters
   * for the pre-charge guarantee.
   */
  connect?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  /** Candidate resolver. Defaults to the vendored client's own. */
  resolveCandidates?: (
    host: string,
    port: number,
  ) => Promise<Array<{ host: string; port: number }>>;
}

/** Parse `--local <port>`. Strict: this becomes part of a URL a run is billed against. */
export function parseLocalPort(raw: string): number {
  const port = Number(raw);
  if (
    raw.trim() !== raw ||
    raw.length === 0 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw localValidationError('local', 'must be a port number between 1 and 65535');
  }
  return port;
}

/**
 * Normalise and validate `--local-host`. Rejects everything outside
 * {@link LOOPBACK_HOSTS} with zero network calls — a tunnel reaches the
 * caller's own machine and nothing else, so a non-loopback value here is a
 * misunderstanding to correct immediately, not a request to forward.
 */
export function normalizeLocalHost(raw: string | undefined): LoopbackHost {
  if (raw === undefined) return DEFAULT_LOCAL_HOST;
  const unbracketed = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  const candidate = unbracketed.trim().toLowerCase();
  const match = LOOPBACK_HOSTS.find(host => host === candidate);
  if (match === undefined) {
    throw localValidationError(
      'local-host',
      `must name your own machine — one of ${LOOPBACK_HOSTS.join(', ')}. ` +
        'A tunnel only reaches the machine running this CLI; to test a reachable ' +
        'address use --target-url instead',
      [...LOOPBACK_HOSTS],
    );
  }
  return match;
}

/**
 * `normalizeLocalHost` for a command whose alternative to `--local` is `--url`
 * (`project create/update`, `project env create/update`) rather than
 * `--target-url`, so the refusal names the flag that command actually has.
 */
export function normalizeStoredLocalHost(raw: string | undefined): LoopbackHost {
  try {
    return normalizeLocalHost(raw);
  } catch (err) {
    if (err instanceof ApiError && typeof err.details?.reason === 'string') {
      throw localValidationError(
        'local-host',
        err.details.reason.replace('--target-url', '--url'),
        err.details.accepted,
      );
    }
    throw err;
  }
}

/** The target `--local <port> [--local-host]` names on a project or environment write. */
export interface StoredLocalTarget {
  host: LoopbackHost;
  port: number;
}

/**
 * Parse the `--local` / `--local-host` / `--url` trio a stored-target write
 * takes. `--local` and `--url` are two spellings of one field, so both is a
 * contradiction; `--local-host` only means something next to `--local`; the
 * port is validated strictly because it becomes part of a URL runs are billed
 * against. Returns the local target, or `undefined` when `--url` (or nothing)
 * was given.
 */
export function parseStoredLocalTarget(opts: {
  local?: string;
  localHost?: string;
  url?: string;
}): StoredLocalTarget | undefined {
  if (opts.local !== undefined && opts.url !== undefined) {
    throw flagPairError('--local and --url are mutually exclusive');
  }
  if (opts.localHost !== undefined && opts.local === undefined) {
    throw flagPairError('--local-host requires --local');
  }
  if (opts.local === undefined) return undefined;
  if (!/^\d+$/.test(opts.local)) {
    throw flagPairError('--local must be a port number between 1 and 65535');
  }
  return { host: normalizeStoredLocalHost(opts.localHost), port: parseLocalPort(opts.local) };
}

function flagPairError(message: string): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request.',
      nextAction: message,
      requestId: 'local',
      details: { reason: 'missing_required_flag' },
    },
  });
}

/**
 * Refuse a stored-target write whose loopback port has nothing listening —
 * the same check `project create --local` runs, so a typo in the port is
 * caught before a row exists anywhere. `skipPreflight` is a pure no-op.
 */
export async function assertStoredLocalTargetListening(
  target: StoredLocalTarget,
  opts: { skipPreflight?: boolean },
  deps: LocalPortProbeDeps = {},
): Promise<void> {
  if (opts.skipPreflight) return;
  const outcome = await probeLocalPort(target.host, target.port, deps);
  if (outcome.verdict === 'refuse') {
    const targetUrl = buildLocalTargetUrl(target.host, target.port);
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: `Nothing is listening on ${targetUrl}. Start your app first, or pass --skip-preflight.`,
        nextAction: 'Verify --local and --local-host match the app you want to test.',
        requestId: 'local',
        details: {
          field: 'local',
          reason: 'local-port-not-listening',
          host: target.host,
          port: target.port,
          probeReason: outcome.reason,
        },
      },
    });
  }
}

/** `http://<host>:<port>`, with IPv6 bracketed as the URL grammar requires. */
export function buildLocalTargetUrl(host: LoopbackHost, port: number): string {
  const authority = host.includes(':') ? `[${host}]` : host;
  return `http://${authority}:${port}`;
}

function dialOnce(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
    };
    const timer = setTimeout(() => {
      cleanup();
      const err = new Error(`connect timeout ${timeoutMs}ms`) as NodeJS.ErrnoException;
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    socket.once('connect', () => {
      cleanup();
      resolve();
    });
    socket.once('error', err => {
      cleanup();
      reject(err);
    });
  });
}

function formatDialTarget(host: string, port: number): string {
  const authority = host.includes(':') ? `[${host}]` : host;
  return `${authority}:${port}`;
}

function describeDialFailure(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === undefined || code === message) return message;
  return `${code} (${message})`;
}

/**
 * Dial every candidate {@link resolveDialCandidates} produces for
 * `host:port`. ANY successful connect is a pass — `localhost` resolves to both
 * `127.0.0.1` and `::1`, and a dev server bound to one family must never be
 * reported dead because the other refused.
 */
export async function probeLocalPort(
  host: string,
  port: number,
  deps: LocalPortProbeDeps = {},
): Promise<LocalPortProbeOutcome> {
  const resolveCandidates = deps.resolveCandidates ?? resolveDialCandidates;
  const connect = deps.connect ?? dialOnce;

  const candidates = await resolveCandidates(host, port);
  if (candidates.length === 0) {
    return {
      verdict: 'refuse',
      reason: `tried resolving ${formatDialTarget(host, port)}; resolver returned no dial candidates`,
    };
  }

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      await connect(candidate.host, candidate.port, LOCAL_PORT_PROBE_TIMEOUT_MS);
      return { verdict: 'ok' };
    } catch (err) {
      failures.push(
        `${formatDialTarget(candidate.host, candidate.port)} -> ${describeDialFailure(err)}`,
      );
    }
  }

  return {
    verdict: 'refuse',
    reason:
      `no candidate connected to ${formatDialTarget(host, port)}; attempts: ` + failures.join('; '),
  };
}

/** Shared refusal wording that names the one explicit bypass exactly once. */
const SKIP_HINT = 'Skip this check with --skip-preflight.';

/**
 * Run {@link probeLocalPort} and either throw (refuse) or no-op (ok / skipped).
 *
 * Call this BEFORE minting a tunnel. That ordering is the feature: DEV-243
 * measured 1,003 blocked-with-URL CLI runs, 55.5% of the third-party-tunnel
 * ones blocked, every one of them charged, because the run row and its credit
 * spend happen before the Lambda ever discovers the target is dead. A dev
 * server that is not running is the single most likely `--local` mistake, and
 * this is the only place it can be caught for free.
 *
 * `skipPreflight: true` is a pure no-op with ZERO connection attempts.
 */
export async function assertLocalPortListening(
  host: LoopbackHost | string,
  port: number,
  opts: { skipPreflight?: boolean },
  _stderrFn: (line: string) => void,
  deps: LocalPortProbeDeps = {},
): Promise<void> {
  if (opts.skipPreflight === true) return;

  const outcome = await probeLocalPort(host, port, deps);
  if (outcome.verdict === 'refuse') {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: `Nothing is listening on ${host}:${port}, so a tunnel run would fail after being billed.`,
        nextAction:
          `Start your app on port ${port} first, or point --local at the port it is actually ` +
          `serving. ${SKIP_HINT}`,
        requestId: 'local',
        details: {
          field: 'local',
          reason: 'local-port-not-listening',
          host,
          port,
          probeReason: outcome.reason,
        },
      },
    });
  }
}
