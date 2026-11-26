import { isProxyAgentActive } from './proxy.js';
import {
  makeHttpClient,
  resolveRequestTimeoutMs,
  type CommonOptions,
  type ClientFactoryDeps,
} from './client-factory.js';
import { globalShutdown, type ShutdownHandle } from './interrupt.js';
import {
  TUNNEL_DATA_PLANE_PROXY_BYPASS_DESCRIPTION,
  openTunnelSession,
  TunnelLostError,
  type TunnelClientHandle,
} from './tunnel-session.js';
import { TunnelClient, type TunnelClientOptions } from '../vendor/tunnel-client/index.js';
import { assertLocalPortListening } from './local-target.js';
import { recordTelemetryExtras, recordTelemetryTunnelOpened } from './telemetry.js';
import type { HttpClient } from './http.js';
import type { RunWaitSnapshot } from './run-wait.js';
import { Output } from './output.js';
import { emitCiArtifacts, isNonDispatchedStatus } from './gh-output.js';
import { buildJUnitReport, skippedRowFromSummary, writeJUnitReportFile } from './junit-report.js';
import { launchIds } from './run-render.js';
import type { CliTestListRunResponse } from './testlist.types.js';
import { buildRunOutput, listResultReceipt, renderRunResults } from './run-output.js';
import { ApiError, InterruptError, RequestTimeoutError, localValidationError } from './errors.js';
import { parseLoopbackTargetUrl, type StoredLocalTarget } from './local-target.js';
import { terminalSafeLine, terminalSafeWriter } from './terminal-text.js';

export interface RunTargetTest {
  type: 'frontend' | 'backend';
  projectId: string;
}
interface Environment {
  name: string;
  url: string;
  isDefault?: boolean;
  isTemporary?: boolean;
}
export interface ResolvedRunTarget extends StoredLocalTarget {
  targetUrl: string;
  automatic: boolean;
  environmentName?: string;
  /** Whether that environment is the project's default, when the server says. */
  environmentIsDefault?: boolean;
}

export const ENVIRONMENT_PREFLIGHT_TIMEOUT_MS = 5_000;

/** Advisory-only reads must not inherit the run's long wait or retry budget. */
export function readEnvironmentPreflight<T>(
  client: Pick<HttpClient, 'get'>,
  path: string,
): Promise<T> {
  // Abort with a RequestTimeoutError as the reason, not AbortSignal.timeout's
  // raw DOMException: HttpClient passes a RequestTimeoutError through
  // untouched, so a stalled preflight read surfaces as REQUEST_TIMEOUT
  // (exit 7) instead of reaching the top-level catch as an uncaught
  // exception. The 5s deadline here is fixed — --request-timeout does not
  // govern it — so the message and nextAction name the preflight read
  // rather than pointing at the flag.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new RequestTimeoutError(ENVIRONMENT_PREFLIGHT_TIMEOUT_MS, 'local', {
        message:
          `Environment preflight read timed out after ` +
          `${ENVIRONMENT_PREFLIGHT_TIMEOUT_MS / 1000}s (client-side).`,
        nextAction:
          'The environment preflight read timed out. ' +
          'Check that the backend is reachable and not overloaded, then retry.',
      }),
    );
  }, ENVIRONMENT_PREFLIGHT_TIMEOUT_MS);
  timer.unref?.();
  return client
    .get<T>(path, { retry: false, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

export function assertNoTunnelOptions(args: {
  tunnelClientId?: string;
  cancelOnInterrupt?: boolean;
}): void {
  if (args.tunnelClientId !== undefined)
    throw localValidationError(
      'tunnel-client',
      '--tunnel-client only applies to a run on a local environment (it attaches the run to an ' +
        'already-running tunnel). Run on one with --env <name>, or remove --tunnel-client',
    );
  if (args.cancelOnInterrupt === false)
    throw localValidationError(
      'cancel-on-interrupt',
      '--no-cancel-on-interrupt only applies to a run on a local environment. An ordinary run is never ' +
        'cancelled when this command stops waiting — Ctrl-C detaches, and `testsprite test ' +
        'cancel <run-id>` is the way to stop one',
    );
}

const announcedEnvironments = new WeakMap<Map<string, Environment[] | undefined>, Set<string>>();

/** One resolver for fresh runs, replay, chained creation and test-list runs. */
export async function resolveEnvironmentRunTarget(args: {
  client: Pick<HttpClient, 'get'>;
  testId?: string;
  knownTest?: RunTargetTest;
  skipTestLookup?: boolean;
  includeBackend?: boolean;
  dryRun?: boolean;
  projectId?: string;
  environment?: string;
  targetUrl?: string;
  tunnelClientId?: string;
  noWait?: boolean;
  verbose?: boolean;
  stderr: (line: string) => void;
  cache?: Map<string, Environment[] | undefined>;
}): Promise<ResolvedRunTarget | undefined> {
  // A run aimed at an address of its own (a pull request preview) leaves the
  // environment's address, and its tunnel, alone.
  if (args.targetUrl !== undefined) return undefined;
  let test = args.knownTest;
  if (!test && args.testId && !args.skipTestLookup) {
    try {
      test = await readEnvironmentPreflight<RunTargetTest>(
        args.client,
        `/tests/${encodeURIComponent(args.testId)}`,
      );
    } catch (err) {
      if (err instanceof InterruptError) throw err;
      return undefined;
    }
  }
  if (test?.type === 'backend' && !args.includeBackend) return undefined;
  const projectId = test?.projectId ?? args.projectId;
  let environments: Environment[] | undefined;
  if (projectId) {
    if (args.cache?.has(projectId)) environments = args.cache.get(projectId);
    else {
      try {
        const listing = await readEnvironmentPreflight<{ environments: Environment[] }>(
          args.client,
          `/projects/${encodeURIComponent(projectId)}/env`,
        );
        if (Array.isArray(listing.environments)) environments = listing.environments;
      } catch (err) {
        if (err instanceof InterruptError) throw err;
        // Read scope, old routes and transient failures do not change legacy runs.
        if (args.verbose)
          args.stderr(
            '[verbose] environment preflight skipped: project environments unavailable; the server will validate this run.',
          );
      }
      args.cache?.set(projectId, environments);
    }
  }
  const selected =
    args.environment === undefined
      ? (environments?.find(row => row.isDefault) ?? environments?.find(row => !row.isTemporary))
      : environments?.find(row => row.name === args.environment);
  const localOf = (row: Environment | undefined): StoredLocalTarget | undefined => {
    if (!row || typeof row.url !== 'string') return undefined;
    try {
      return parseLoopbackTargetUrl(row.url);
    } catch {
      return undefined;
    }
  };
  const announced = args.cache
    ? (announcedEnvironments.get(args.cache) ?? new Set<string>())
    : new Set<string>();
  if (args.cache) announcedEnvironments.set(args.cache, announced);
  const announce = (key: string, line: string): void => {
    if (!announced.has(key)) args.stderr(line);
    announced.add(key);
  };
  const local = localOf(selected);
  if (!local) return undefined;
  if (args.noWait) {
    announce(
      `no-wait:${projectId}:${selected!.name}:${selected!.url}`,
      '[hint] This environment needs a tunnel; drop --no-wait to run through a tunnel.',
    );
    return undefined;
  }
  if (!args.tunnelClientId && test?.type !== 'backend') {
    const key = `${projectId}:${selected!.name}:${selected!.url}`;
    announce(
      key,
      args.dryRun
        ? `Would open a tunnel to ${terminalSafeLine(selected!.url)} (environment "${terminalSafeLine(selected!.name)}").`
        : `Environment "${terminalSafeLine(selected!.name)}" is on this machine (${terminalSafeLine(selected!.url)}) — opening a tunnel.`,
    );
  }
  return {
    ...local,
    targetUrl: selected!.url,
    automatic: args.tunnelClientId === undefined,
    environmentName: selected!.name,
    ...(selected!.isDefault !== undefined ? { environmentIsDefault: selected!.isDefault } : {}),
  };
}

export function unsupportedTunnelError(command: string): ApiError {
  return new ApiError({
    code: 'UNSUPPORTED',
    message: `This server did not confirm tunnel use for ${command}. Cancellation was attempted for the started runs; no tunnel-free result can be trusted.`,
    nextAction: 'Update the server, or use testsprite run <id> with the saved environment.',
    requestId: 'local',
    details: {},
  });
}

export interface EnvironmentTunnelContext {
  client: HttpClient;
  clientId: string;
  targets?: ReadonlyMap<string, ResolvedRunTarget>;
  maxConcurrency: number;
  deadlineMs: number;
  session: Awaited<ReturnType<typeof openTunnelSession>>;
  cancellation: (runId: string) => 'cancelled' | 'cancel-failed' | 'already-terminal' | undefined;
  cancelActive: () => Promise<void>;
  skipped?: Array<{ testId: string; reason: 'backend-test' }>;
  resultStatus: (resultId: string) => string | undefined;
  confirm: (
    response: { tunnelClientId?: string },
    runIds: string[],
    requireEcho?: boolean,
  ) => Promise<void>;
  onRead: (snapshot: RunWaitSnapshot, signal: AbortSignal) => Promise<void>;
}

/** Own tunnel lifecycle and executions, without a client-side dispatch capacity loop. */
export async function withEnvironmentTunnel<T>(
  opts: CommonOptions & {
    skipPreflight?: boolean;
    maxConcurrency?: number;
    timeoutSeconds?: number;
    tunnelClientId?: string;
    cancelOnInterrupt?: boolean;
  },
  deps: ClientFactoryDeps & {
    shutdown?: ShutdownHandle;
    createTunnelClient?: (options: TunnelClientOptions) => TunnelClientHandle;
    sleep?: (ms: number) => Promise<void>;
  },
  targets: ResolvedRunTarget[],
  command: string,
  operation: (context: EnvironmentTunnelContext) => Promise<T>,
): Promise<T> {
  const stderr = terminalSafeWriter(deps.stderr);
  const shutdown = deps.shutdown ?? globalShutdown;
  if (isProxyAgentActive())
    stderr(
      `[advisory] An HTTP proxy is configured for this process. The tunnel control channel honours it, but ${TUNNEL_DATA_PLANE_PROXY_BYPASS_DESCRIPTION} — if the run cannot reach your machine, an egress proxy is the first thing to rule out.`,
    );
  recordTelemetryExtras({ localConcurrencyLimit: opts.maxConcurrency ?? 5 });
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.targetUrl)) continue;
    seen.add(target.targetUrl);
    await assertLocalPortListening(
      target.host,
      target.port,
      { ...opts, ...(target.automatic ? { environmentName: target.environmentName } : {}) },
      stderr,
    );
  }
  const requestTimeoutMs = resolveRequestTimeoutMs(opts, deps.env ?? process.env);
  const request = async <R>(
    timeoutMs: number,
    operation: (client: HttpClient) => Promise<R>,
  ): Promise<R> => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new RequestTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
    try {
      return await operation(
        makeHttpClient(
          { ...opts, requestTimeoutMs: timeoutMs },
          { ...deps, shutdownSignal: deadline.signal, shutdown },
        ),
      );
    } finally {
      clearTimeout(timer);
    }
  };
  const cleanup = <R>(operation: (client: HttpClient) => Promise<R>): Promise<R> =>
    request(10_000, operation);
  const client = makeHttpClient(opts, { ...deps, shutdownSignal: shutdown.signal, shutdown });
  const livenessClient = makeHttpClient(
    { ...opts, debug: false, verbose: false },
    { ...deps, shutdownSignal: shutdown.signal, shutdown },
  );
  const active = new Set<string>();
  const statuses = new Map<string, string>();
  const cancellations = new Map<string, 'cancelled' | 'cancel-failed' | 'already-terminal'>();
  let failure: unknown;
  let session: Awaited<ReturnType<typeof openTunnelSession>> | undefined;
  let ownerGone = false;
  let lastLivenessRead = -Infinity;
  const cancel = async (force = false): Promise<void> => {
    if (!force && (opts.cancelOnInterrupt === false || (session?.adopted && !ownerGone))) return;
    for (const runId of active) {
      try {
        const cancelled = await cleanup(transport => transport.cancelRun(runId));
        cancellations.set(runId, cancelled.alreadyFinished ? 'already-terminal' : 'cancelled');
        stderr(
          cancelled.alreadyFinished
            ? `[tunnel] Run ${terminalSafeLine(runId)} had already finished; no cancellation was needed.`
            : `[tunnel] Cancellation requested for run ${terminalSafeLine(runId)}; its tunnel is closing.`,
        );
        for (const result of cancelled.results)
          if (result.refund?.status === 'failed')
            stderr(
              `[tunnel] Refund failed for result ${terminalSafeLine(result.resultId)}: inspect the cancellation response or contact support.`,
            );
      } catch (err) {
        cancellations.set(runId, 'cancel-failed');
        stderr(
          `[tunnel] Could not cancel run ${terminalSafeLine(runId)}: ${terminalSafeLine(err instanceof Error ? err.message : String(err))}. Use testsprite run cancel ${terminalSafeLine(runId)}.`,
        );
      }
      active.delete(runId);
    }
  };
  const disarm = shutdown.arm();
  try {
    try {
      session = await openTunnelSession(
        {
          log: stderr,
          onMinted: ({ clientId }) =>
            stderr(`[tunnel] Minted tunnel client ${terminalSafeLine(clientId)}`),
          logLevel: opts.debug ? 'debug' : opts.verbose ? 'info' : 'error',
          ...(opts.tunnelClientId
            ? { adopt: { clientId: opts.tunnelClientId, expiresAt: '' } }
            : {}),
        },
        {
          mint: ttlSeconds =>
            request(requestTimeoutMs, transport =>
              transport.mintTunnel({ ...(ttlSeconds ? { ttlSeconds } : {}) }),
            ),
          destroy: clientId => cleanup(transport => transport.deleteTunnel(clientId)),
          createClient: shutdownAwareTunnelClient(
            deps.createTunnelClient ?? (options => new TunnelClient(options)),
            shutdown.signal,
          ),
        },
      );
    } catch (err) {
      if (shutdown.signal.aborted) throw shutdown.signal.reason;
      throw err;
    }
    recordTelemetryTunnelOpened(!session.adopted);
    const dispatch = <R>(operation: (transport: HttpClient) => Promise<R>): Promise<R> => {
      if (shutdown.signal.aborted) throw shutdown.signal.reason;
      if (session!.fatalReason())
        throw new TunnelLostError(session!.fatalReason()!, {}, session!.fatalMessage());
      // Keep the response across the first interrupt so its owned run can be cancelled.
      return request(requestTimeoutMs, operation);
    };
    client.triggerProjectRun = (...args) =>
      dispatch(transport => transport.triggerProjectRun(...args));
    client.triggerTestListRun = (...args) =>
      dispatch(transport => transport.triggerTestListRun(...args));
    return await operation({
      client,
      session,
      clientId: session.clientId,
      maxConcurrency: opts.maxConcurrency ?? 5,
      deadlineMs: Date.now() + (opts.timeoutSeconds ?? 600) * 1000,
      cancellation: runId => cancellations.get(runId),
      cancelActive: () => cancel(),
      resultStatus: resultId => statuses.get(resultId),
      confirm: async (response, runIds, requireEcho = true) => {
        for (const runId of runIds) active.add(runId);
        if (requireEcho && runIds.length > 0 && response.tunnelClientId !== session!.clientId) {
          await cancel(true);
          throw unsupportedTunnelError(command);
        }
      },
      onRead: async ({ run, results }, signal) => {
        for (const result of results)
          statuses.set(result.resultId, result.testStatus.toLowerCase());
        if (run.status === 'finished') {
          active.delete(run.runId);
          return;
        }
        if (!active.has(run.runId)) return;
        const fatal = session!.fatalReason();
        if (fatal) throw new TunnelLostError(fatal, { runId: run.runId }, session!.fatalMessage());
        if (session!.adopted && Date.now() - lastLivenessRead >= 15_000) {
          lastLivenessRead = Date.now();
          try {
            const observed = await livenessClient.getTunnelStatus(session!.clientId, {
              signal,
              retry: false,
            });
            ownerGone = observed.status.toLowerCase() === 'offline';
          } catch (err) {
            ownerGone = err instanceof ApiError && err.httpStatus === 404;
          }
          if (ownerGone) throw new TunnelLostError('owner-gone', { runId: run.runId });
        }
      },
    });
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    const closing = [...active];
    await cancel();
    if (failure instanceof InterruptError && closing.length && (!session?.adopted || ownerGone)) {
      const cancelled = closing.every(id => cancellations.get(id) === 'cancelled');
      const nextAction = cancelled
        ? `The owned tunnel closed; cancellation was requested for runs ${closing.join(' ')}. Start a new run to test the local target again.`
        : `The owned tunnel closed; cancellation was not confirmed. Stop the runs with testsprite run cancel ${closing.join(' ')}.`;
      Object.assign(failure, {
        runWaitContext: true,
        tunnelDetach: {
          runId: closing[0],
          cancel: cancelled ? 'cancelled' : opts.cancelOnInterrupt === false ? 'skipped' : 'failed',
          nextAction,
        },
      });
    }
    try {
      await session?.close();
    } finally {
      disarm();
    }
  }
}

function shutdownAwareTunnelClient(
  create: (options: TunnelClientOptions) => TunnelClientHandle,
  signal: AbortSignal,
): (options: TunnelClientOptions) => TunnelClientHandle {
  return options => {
    const client = create(options);
    return {
      start: async () => {
        if (signal.aborted) throw signal.reason;
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          client
            .start()
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort));
        });
      },
      stop: () => {
        const stopped = client.stop();
        if (!signal.aborted) return stopped;
        void stopped.catch(() => {});
        return Promise.resolve();
      },
    };
  };
}

/** Keep each dispatch on one verbatim loopback URL; public runs omit tunnel fields. */
export function groupEnvironmentTargets(
  ids: string[],
  targets: ReadonlyMap<string, { targetUrl: string }>,
): string[][] {
  const groups = new Map<string | undefined, string[]>();
  for (const id of ids) {
    const key = targets.get(id)?.targetUrl;
    const group = groups.get(key) ?? [];
    group.push(id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function quoteEnvironmentName(name: string): string {
  return "'" + name.replaceAll("'", "'\\''") + "'";
}

export async function emitEnvironmentDispatchPartial(
  responses: readonly CliTestListRunResponse[],
  testIds: string[],
  opts: CommonOptions & {
    report?: 'junit';
    reportFile?: string;
    reportSuiteName?: string;
    ghOutput?: boolean;
    summaryFile?: string;
  },
  deps: ClientFactoryDeps & {
    stdout?: (line: string) => void;
  },
  label: string,
  error: unknown,
  context: EnvironmentTunnelContext,
  /** The reason a `notFound` id was not dispatched (`run --testlist`: not a member of the list). */
  notFoundNote?: string,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut =
    error instanceof RequestTimeoutError ||
    (error instanceof ApiError && error.code === 'UNSUPPORTED' && message.startsWith('Timed out'));
  const accepted = responses
    .flatMap(response => response.accepted)
    .map(listResultReceipt)
    .map(row => ({
      ...row,
      status:
        (row.runId ? context.cancellation(row.runId) : undefined) ??
        context.resultStatus(row.resultId) ??
        (timedOut ? 'timeout' : 'running'),
    }));
  const conflicts = responses.flatMap(response => response.conflicts);
  const deferred = responses.flatMap(response => response.deferred);
  const notFound = responses.flatMap(response => response.notFound ?? []);
  const seen = new Set([...accepted, ...conflicts, ...deferred].map(row => row.testId));
  for (const id of notFound) seen.add(id);
  const notRunTestIds = testIds.filter(id => !seen.has(id));
  const buckets = {
    conflicts,
    deferred,
    ...(context.skipped?.length ? { skipped: context.skipped } : {}),
    ...(responses.some(response => response.notFound) ? { notFound } : {}),
  };
  const { output, summary } = buildRunOutput({
    receipts: launchIds(accepted).map(runId => ({ runId })),
    dispatched: accepted,
    wait: true,
    failure: error,
    requestTimedOut: timedOut,
    incompleteDispatch: true,
    cancellation: context.cancellation,
    buckets: {
      ...buckets,
      skipped: [
        ...(context.skipped ?? []),
        ...notRunTestIds.map(testId => ({
          testId,
          reason: 'not dispatched before the owned tunnel closed',
        })),
      ],
    },
    notFoundNote,
  });
  const stderr = terminalSafeWriter(deps.stderr);
  new Output(opts.output, { stdout: deps.stdout, stderr: deps.stderr }).print(
    { ...output, ...buckets, notRunTestIds },
    () => renderRunResults(output.runs, output.results, summary),
  );
  emitCiArtifacts(
    summary,
    opts,
    {
      env: deps.env ?? process.env,
      stdout: deps.stdout ?? (line => process.stdout.write(`${line}\n`)),
      stderr,
    },
    label,
  );
  if (opts.report === 'junit' && opts.reportFile !== undefined) {
    try {
      await writeJUnitReportFile(
        opts.reportFile,
        buildJUnitReport({
          suiteName: opts.reportSuiteName ?? `testsprite:${label}`,
          classname: label,
          // A test that never dispatched is skipped with its own reason. A
          // dispatched one keeps the status it reached (running, timeout, a
          // verdict) and names the error that closed the tunnel, which is why
          // this is not `junitRowsFromSummary`.
          results: summary.results.map(row =>
            isNonDispatchedStatus(row.status)
              ? skippedRowFromSummary(row)
              : {
                  testId: row.testId ?? row.resultId ?? '(unknown)',
                  resultId: row.resultId,
                  runId: row.runId,
                  status: row.status,
                  error: { code: error instanceof ApiError ? error.code : 'UNSUPPORTED', message },
                },
          ),
        }),
      );
    } catch (err) {
      stderr(
        `Could not write the partial JUnit report: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
