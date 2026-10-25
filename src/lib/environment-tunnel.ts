import {
  makeHttpClient,
  resolveRequestTimeoutMs,
  type CommonOptions,
  type ClientFactoryDeps,
} from './client-factory.js';
import { globalShutdown, type ShutdownHandle } from './interrupt.js';
import { openTunnelSession, TunnelLostError, type TunnelClientHandle } from './tunnel-session.js';
import { TunnelClient, type TunnelClientOptions } from '../vendor/tunnel-client/index.js';
import { assertLocalPortListening } from './local-target.js';
import { recordTelemetryTunnelOpened } from './telemetry.js';
import type { HttpClient } from './http.js';
import type { RunResponse } from './runs.types.js';
import { Output } from './output.js';
import { emitCiArtifacts, summarizeAcceptedPayload } from './gh-output.js';
import { buildJUnitReport, writeJUnitReportFile } from './junit-report.js';
import { pollRunUntilTerminal, TimeoutError, isTerminalStatus } from './poll.js';
import { ApiError, InterruptError, RequestTimeoutError, localValidationError } from './errors.js';
import {
  buildLocalTargetUrl,
  DEFAULT_LOCAL_HOST,
  parseLoopbackTargetUrl,
  type LoopbackHost,
  type StoredLocalTarget,
} from './local-target.js';

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
}

export const ENVIRONMENT_PREFLIGHT_TIMEOUT_MS = 5_000;

/** Advisory-only reads must not inherit the run's long wait or retry budget. */
export function readEnvironmentPreflight<T>(
  client: Pick<HttpClient, 'get'>,
  path: string,
): Promise<T> {
  return client.get<T>(path, {
    retry: false,
    signal: AbortSignal.timeout(ENVIRONMENT_PREFLIGHT_TIMEOUT_MS),
  });
}

export function assertNoTunnelOptions(args: {
  tunnelClientId?: string;
  cancelOnInterrupt?: boolean;
}): void {
  if (args.tunnelClientId !== undefined)
    throw localValidationError(
      'tunnel-client',
      '--tunnel-client only applies with --local (it attaches the run to an already-running ' +
        'tunnel). Add --local <port>, or remove --tunnel-client',
    );
  if (args.cancelOnInterrupt === false)
    throw localValidationError(
      'cancel-on-interrupt',
      '--no-cancel-on-interrupt only applies with --local. An ordinary run is never ' +
        'cancelled when this command stops waiting — Ctrl-C detaches, and `testsprite test ' +
        'cancel <run-id>` is the way to stop one',
    );
}

export function severalIdsWithoutTunnel(): never {
  throw localValidationError(
    'test-id',
    'several test ids run through one tunnel with --local <port>. For tests the runner can already reach, use `testsprite test run --all --project <id> [--filter <text>]`, or run them one at a time.',
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
  localPort?: number;
  localHost?: LoopbackHost;
  targetUrl?: string;
  tunnelClientId?: string;
  noWait?: boolean;
  verbose?: boolean;
  stderr: (line: string) => void;
  cache?: Map<string, Environment[] | undefined>;
}): Promise<ResolvedRunTarget | undefined> {
  const explicitUrl =
    args.targetUrl === undefined ? undefined : parseLoopbackTargetUrl(args.targetUrl);
  const explicit = args.localPort !== undefined || explicitUrl !== undefined;
  if (args.targetUrl !== undefined && !explicitUrl) return undefined;
  let test = args.knownTest;
  if (!test && args.testId && !args.skipTestLookup) {
    try {
      test = await readEnvironmentPreflight<RunTargetTest>(
        args.client,
        `/tests/${encodeURIComponent(args.testId)}`,
      );
    } catch (err) {
      if (err instanceof InterruptError) throw err;
      if (explicit) {
        if (
          err instanceof ApiError &&
          (err.httpStatus === 403 || err.httpStatus === 404 || err.code === 'UNAVAILABLE')
        ) {
          throw new ApiError(
            {
              code: err.code,
              message: `Cannot read test ${args.testId} for --local preflight.`,
              nextAction: 'Check the test ID and read:tests permission, then retry.',
              requestId: err.requestId,
              details: {},
            },
            err.httpStatus,
          );
        }
        throw err;
      }
      return undefined;
    }
  }
  if (test?.type === 'backend' && !args.includeBackend) {
    if (explicit)
      throw localValidationError(
        'local',
        `backend tests don't open a browser; the tunnel is not used. Run: testsprite test run ${args.testId}`,
      );
    return undefined;
  }
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
  if (explicit && args.environment !== undefined && environments && !selected) {
    const available = environments.map(row => row.name).sort();
    throw localValidationError(
      'env',
      `unknown environment '${args.environment}'; use one of: ${available.join(', ')}`,
      available,
    );
  }
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
  const explicitTarget = (target: ResolvedRunTarget): ResolvedRunTarget => {
    if (args.environment !== undefined && selected && !localOf(selected))
      announce(
        `sign-in:${projectId}:${selected.name}:${target.targetUrl}`,
        `Using environment "${selected.name}" sign-in against ${target.targetUrl} through a tunnel.`,
      );
    return target;
  };
  if (explicitUrl)
    return explicitTarget({ ...explicitUrl, targetUrl: args.targetUrl!, automatic: false });
  if (args.localPort !== undefined) {
    const selectedHost = localOf(selected)?.host;
    const matching =
      environments?.filter(row => !row.isTemporary && localOf(row)?.port === args.localPort) ?? [];
    const hosts = new Set(matching.map(row => localOf(row)!.host));
    const host =
      args.localHost ??
      selectedHost ??
      (hosts.size === 1 ? [...hosts][0] : undefined) ??
      (environments === undefined ? '127.0.0.1' : DEFAULT_LOCAL_HOST);
    return explicitTarget({
      host,
      port: args.localPort,
      targetUrl: buildLocalTargetUrl(host, args.localPort),
      automatic: false,
    });
  }
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
        ? `Would open a tunnel to ${selected!.url} (environment "${selected!.name}").`
        : `Environment "${selected!.name}" is on this machine (${selected!.url}) — opening a tunnel.`,
    );
  }
  return {
    ...local,
    targetUrl: selected!.url,
    automatic: args.tunnelClientId === undefined,
    environmentName: selected!.name,
  };
}

export function tunnelScopeError(err: unknown): unknown {
  if (!(err instanceof ApiError) || err.httpStatus !== 403) return err;
  return new ApiError(
    {
      code: err.code,
      message: err.message,
      requestId: err.requestId,
      details: err.details,
      nextAction: `${err.nextAction ?? ''} A tunnel is required for this environment; use an API key with run:tunnel permission.`,
    },
    err.httpStatus,
  );
}

export function unsupportedTunnelError(command: string): ApiError {
  return new ApiError({
    code: 'UNSUPPORTED',
    message: `This server did not confirm tunnel use for ${command}. Cancellation was attempted for the started runs; no tunnel-free result can be trusted.`,
    nextAction: 'Update the server, or use testsprite test run <id> with the saved environment.',
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
  cancellation: (runId: string) => 'cancelled' | 'cancel-failed' | undefined;
  skipped?: Array<{ testId: string; reason: 'backend-test' }>;
  terminalRun: (runId: string) => RunResponse | undefined;
  waitForCapacity: (incoming: number) => Promise<void>;
  confirm: (
    response: { tunnelClientId?: string },
    runIds: string[],
    requireEcho?: boolean,
  ) => Promise<void>;
  onPoll: (run: { runId: string; status: string }) => void;
}

/** Replay and list dispatch keep their existing envelopes under one owned tunnel. */
export async function withEnvironmentTunnel<T>(
  opts: CommonOptions & {
    skipPreflight?: boolean;
    maxConcurrency?: number;
    timeoutSeconds?: number;
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
  const stderr = deps.stderr ?? (line => process.stderr.write(`${line}\n`));
  const shutdown = deps.shutdown ?? globalShutdown;
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
  const active = new Set<string>();
  const terminalRuns = new Map<string, RunResponse>();
  const getRun = client.getRun.bind(client);
  client.getRun = async (runId, options) => {
    const cached = terminalRuns.get(runId);
    if (cached) return cached;
    const run = await getRun(runId, options);
    if (isTerminalStatus(run.status)) terminalRuns.set(runId, run);
    return run;
  };
  const cancellations = new Map<string, 'cancelled' | 'failed'>();
  let failure: unknown;
  let context: EnvironmentTunnelContext | undefined;
  const cancel = async () => {
    for (const runId of active) {
      try {
        await cleanup(transport => transport.cancelRun(runId));
        cancellations.set(runId, 'cancelled');
        stderr(`[tunnel] Cancellation requested for ${runId}; the owned tunnel is closing.`);
      } catch (err) {
        cancellations.set(runId, 'failed');
        stderr(
          `[tunnel] Could not cancel ${runId}: ${err instanceof Error ? err.message : String(err)}. Use testsprite test cancel ${runId}.`,
        );
      }
      active.delete(runId);
    }
  };
  const disarm = shutdown.arm();
  let session: Awaited<ReturnType<typeof openTunnelSession>> | undefined;
  try {
    try {
      session = await openTunnelSession(
        { log: stderr, logLevel: opts.debug ? 'debug' : opts.verbose ? 'info' : 'error' },
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
      throw tunnelScopeError(err);
    }
    recordTelemetryTunnelOpened(true);
    if (shutdown.signal.aborted) throw shutdown.signal.reason;
    const checkDispatch = (): void => {
      if (shutdown.signal.aborted) throw shutdown.signal.reason;
      if (session!.fatalReason())
        throw new TunnelLostError(session!.fatalReason()!, '', session!.fatalMessage());
    };
    // Retain a charged response across the first interrupt, with a total retry deadline.
    const dispatch = <R>(operation: (transport: HttpClient) => Promise<R>): Promise<R> => {
      checkDispatch();
      return request(requestTimeoutMs, operation);
    };
    client.triggerRerun = (...args) => dispatch(transport => transport.triggerRerun(...args));
    client.triggerBatchRerun = (...args) =>
      dispatch(transport => transport.triggerBatchRerun(...args));
    client.triggerTestListRun = (...args) =>
      dispatch(transport => transport.triggerTestListRun(...args));
    client.triggerRunWithMeta = (...args) =>
      dispatch(transport => transport.triggerRunWithMeta(...args));
    const deadlineMs = Date.now() + (opts.timeoutSeconds ?? 600) * 1000;
    const assertCapacityDeadline = (): void => {
      if (Date.now() >= deadlineMs)
        throw new ApiError({
          code: 'UNSUPPORTED',
          message: `Timed out after ${opts.timeoutSeconds ?? 600}s waiting for tunnel batch capacity.`,
          nextAction:
            'The owned tunnel is closing; inspect cancellation with testsprite test cancel <run-id>.',
          requestId: 'local',
          details: {},
        });
    };
    context = {
      client,
      session,
      deadlineMs,
      cancellation: id => {
        const outcome = cancellations.get(id);
        return outcome === 'failed' ? 'cancel-failed' : outcome;
      },
      clientId: session.clientId,
      maxConcurrency: opts.maxConcurrency ?? 5,
      terminalRun: runId => terminalRuns.get(runId),
      waitForCapacity: async incoming => {
        assertCapacityDeadline();
        while (active.size + incoming > (opts.maxConcurrency ?? 5)) {
          const runId = active.values().next().value!;
          try {
            await pollRunUntilTerminal(client, runId, {
              timeoutSeconds: Math.max(0, (deadlineMs - Date.now()) / 1000),
              shutdown,
              sleep: deps.sleep,
              onTick: run => context!.onPoll(run),
            });
          } catch (err) {
            if (!(err instanceof TimeoutError)) throw err;
            throw new ApiError({
              code: 'UNSUPPORTED',
              message: err.message,
              nextAction: `The owned tunnel is closing; inspect cancellation with testsprite test cancel ${runId}.`,
              requestId: 'local',
              details: { runId },
            });
          }
        }
        assertCapacityDeadline();
      },
      confirm: async (response, runIds, requireEcho = true) => {
        for (const id of runIds) active.add(id);
        if (requireEcho && runIds.length && response.tunnelClientId !== session!.clientId) {
          await cancel();
          throw unsupportedTunnelError(command);
        }
      },
      onPoll: run => {
        if (['passed', 'failed', 'blocked', 'cancelled'].includes(run.status))
          active.delete(run.runId);
        else if (active.has(run.runId) && session!.fatalReason())
          throw new TunnelLostError(session!.fatalReason()!, run.runId, session!.fatalMessage());
      },
    };
    return await operation(context!);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    const closing = [...active];
    await cancel();
    if (failure instanceof InterruptError && closing.length) {
      const runId = closing[0]!;
      const cancelOutcome = closing.every(id => cancellations.get(id) === 'cancelled')
        ? 'cancelled'
        : 'failed';
      const retry =
        [...(context?.targets ?? [])]
          .map(
            ([id, target]) =>
              `testsprite test run ${id}${target.environmentName ? ` --env ${quoteEnvironmentName(target.environmentName)}` : ''}`,
          )
          .join('; ') || 'testsprite test run <id>';
      const nextAction = `The owned tunnel is closing; cancellation was ${cancelOutcome === 'cancelled' ? 'requested' : 'attempted'} for ${closing.join(' ')}. Inspect with testsprite test cancel ${closing.join(' ')}. Start a new run with ${retry}.`;
      Object.assign(failure, {
        runWaitContext: true,
        tunnelDetach: { runId, cancel: cancelOutcome, nextAction },
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
  targets: ReadonlyMap<string, ResolvedRunTarget>,
  maxLocalGroupSize = Infinity,
): string[][] {
  const groups = new Map<string | undefined, string[]>();
  for (const id of ids) {
    const key = targets.get(id)?.targetUrl;
    const group = groups.get(key) ?? [];
    group.push(id);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap(group => {
    if (!targets.has(group[0]!) || !Number.isFinite(maxLocalGroupSize)) return [group];
    const chunks: string[][] = [];
    for (let index = 0; index < group.length; index += maxLocalGroupSize)
      chunks.push(group.slice(index, index + maxLocalGroupSize));
    return chunks;
  });
}

export function quoteEnvironmentName(name: string): string {
  return "'" + name.replaceAll("'", "'\\''") + "'";
}

export async function emitEnvironmentDispatchPartial(
  responses: Array<{
    accepted: Array<{ testId: string; runId: string }>;
    conflicts: Array<{ testId: string }>;
    deferred: Array<{ testId: string }>;
    notFound?: string[];
  }>,
  testIds: string[],
  opts: CommonOptions & {
    report?: 'junit';
    reportFile?: string;
    reportSuiteName?: string;
    ghOutput?: boolean;
    summaryFile?: string;
  },
  deps: ClientFactoryDeps & { stdout?: (line: string) => void },
  label: string,
  error: unknown,
  context: EnvironmentTunnelContext,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut =
    error instanceof RequestTimeoutError ||
    (error instanceof ApiError && error.code === 'UNSUPPORTED' && message.startsWith('Timed out'));
  const accepted = responses
    .flatMap(response => response.accepted)
    .map(row => ({
      ...row,
      status:
        context.cancellation(row.runId) ??
        context.terminalRun(row.runId)?.status ??
        (timedOut ? 'timeout' : 'running'),
    }));
  const conflicts = responses.flatMap(response => response.conflicts);
  const deferred = responses.flatMap(response => response.deferred);
  const notFound = responses.flatMap(response => response.notFound ?? []);
  const seen = new Set([...accepted, ...conflicts, ...deferred].map(row => row.testId));
  for (const id of notFound) seen.add(id);
  const notRunTestIds = testIds.filter(id => !seen.has(id));
  const partial = {
    accepted,
    conflicts,
    deferred,
    ...(context.skipped?.length ? { skipped: context.skipped } : {}),
    notRunTestIds,
    ...(responses.some(response => response.notFound) ? { notFound } : {}),
  };
  const stderr = deps.stderr ?? (line => process.stderr.write(`${line}\n`));
  new Output(opts.output, { stdout: deps.stdout, stderr: deps.stderr }).print(partial, () =>
    accepted.map(row => `${row.runId}  ${row.status}`).join('\n'),
  );
  const summary = summarizeAcceptedPayload(JSON.stringify(partial));
  summary.runs.push(
    ...notRunTestIds.map(testId => ({
      testId,
      status: 'skipped',
      error: 'not dispatched before the owned tunnel closed',
    })),
  );
  summary.total += notRunTestIds.length;
  summary.skipped += notRunTestIds.length;
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
          results: summary.runs.map(row => ({
            testId: row.testId,
            runId: row.runId,
            status: row.status,
            error: { code: error instanceof ApiError ? error.code : 'UNSUPPORTED', message },
          })),
        }),
      );
    } catch (err) {
      stderr(
        `Could not write the partial JUnit report: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
