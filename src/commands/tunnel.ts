/**
 * `testsprite tunnel start | status | stop` — DEV-747 piece 3.
 *
 * The out-of-band primitive under `test run --local`, which is sugar over it.
 * Two things it buys that the sugar cannot:
 *
 *   - **One tunnel, many runs.** `tunnel start` in one terminal, then
 *     `test run <id> --local <port> --tunnel-client <id>` as many times as you
 *     like in another. Each run would otherwise mint and tear down its own
 *     credential, and the per-principal live-binding cap is small.
 *   - **A place to look when a run says the tunnel is down.** `tunnel status`
 *     answers "is my client connected" without spending a run to find out.
 *
 * There is deliberately no daemon (design ledger D1 (b), deferred): `tunnel
 * start` holds the tunnel in the FOREGROUND and closes it when you stop the
 * command. That is not a limitation to work around with `&` — the secret lives
 * only in this process's memory, and detaching it would mean persisting a
 * credential that opens an inbound path into this machine. `config.json`
 * credentials are a settled no in this codebase.
 */

import { Command } from 'commander';
import type { CommonOptions } from '../lib/client-factory.js';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  resolveRequestTimeoutMs,
} from '../lib/client-factory.js';
import { ApiError, RequestTimeoutError } from '../lib/errors.js';
import type { HttpClient } from '../lib/http.js';
import { globalShutdown, type ShutdownHandle } from '../lib/interrupt.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import { openTunnelSession, type TunnelClientHandle } from '../lib/tunnel-session.js';
import type { TunnelStatusResponse } from '../lib/tunnel.types.js';
import { TunnelClient, type TunnelClientOptions } from '../vendor/tunnel-client/index.js';

export interface TunnelDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: typeof globalThis.fetch;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  shutdown?: ShutdownHandle;
  /** Injectable tunnel-client factory (tests). Defaults to the vendored client. */
  createTunnelClient?: (options: TunnelClientOptions) => TunnelClientHandle;
}

export interface TunnelStartOptions extends CommonOptions {
  /** Requested binding lifetime in seconds. Server clamps to [60, 28800]. */
  ttlSeconds?: number;
}

export interface TunnelClientIdOptions extends CommonOptions {
  clientId: string;
}

function stdoutOf(deps: TunnelDeps): (line: string) => void {
  return deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
}

function stderrOf(deps: TunnelDeps): (line: string) => void {
  return deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
}

function makeClient(
  opts: CommonOptions,
  deps: TunnelDeps,
  shutdownSignal: AbortSignal = (deps.shutdown ?? globalShutdown).signal,
): HttpClient {
  return makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
    shutdownSignal,
  });
}

async function withUninterruptibleRequest<T>(
  opts: CommonOptions,
  deps: TunnelDeps,
  timeoutMs: number,
  operation: (client: HttpClient) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new RequestTimeoutError(timeoutMs));
  }, timeoutMs);
  timer.unref?.();
  try {
    return await operation(
      makeClient({ ...opts, requestTimeoutMs: timeoutMs }, deps, deadline.signal),
    );
  } finally {
    clearTimeout(timer);
  }
}

function shutdownAwareTunnelClientFactory(
  createClient: (options: TunnelClientOptions) => TunnelClientHandle,
  signal: AbortSignal,
): (options: TunnelClientOptions) => TunnelClientHandle {
  return options => {
    const client = createClient(options);
    return {
      start: async () => {
        if (signal.aborted) throw signal.reason;
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => reject(signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          client.start().then(
            () => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            },
            err => {
              signal.removeEventListener('abort', onAbort);
              reject(err);
            },
          );
        });
      },
      stop: () => {
        const stopping = client.stop();
        if (!signal.aborted) return stopping;
        void stopping.catch(() => {});
        return Promise.resolve();
      },
    };
  };
}

/**
 * A client for teardown, whose requests are NOT composed with the shutdown
 * signal. `tunnel start` ends because of a Ctrl-C essentially every time, and
 * the delete it issues at that moment must actually leave the machine — see
 * the same helper in `commands/test.ts`.
 */
function makeDetachedClient(
  opts: CommonOptions,
  deps: TunnelDeps,
  operationSignal: AbortSignal,
): HttpClient {
  return makeHttpClient(
    { ...opts, requestTimeoutMs: TEARDOWN_OPERATION_TIMEOUT_MS },
    {
      env: deps.env,
      credentialsPath: deps.credentialsPath,
      fetchImpl: deps.fetchImpl,
      stderr: deps.stderr,
      shutdownSignal: operationSignal,
    },
  );
}

async function withTeardownDeadline<T>(
  opts: CommonOptions,
  deps: TunnelDeps,
  operation: (client: HttpClient) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new RequestTimeoutError(TEARDOWN_OPERATION_TIMEOUT_MS));
  }, TEARDOWN_OPERATION_TIMEOUT_MS);
  timer.unref?.();
  const shutdown = deps.shutdown ?? globalShutdown;
  try {
    return await shutdown.runCriticalOperation(() =>
      operation(makeDetachedClient(opts, deps, deadline.signal)),
    );
  } finally {
    clearTimeout(timer);
  }
}

async function deleteTunnelForCleanup(
  opts: CommonOptions,
  deps: TunnelDeps,
  clientId: string,
): Promise<void> {
  await withTeardownDeadline(opts, deps, client =>
    client.delete<unknown>(`/tunnel/${encodeURIComponent(clientId)}`, {
      allowNoContent: true,
    }),
  );
}

const TEARDOWN_OPERATION_TIMEOUT_MS = 10_000;

function makeOutput(mode: OutputMode, deps: TunnelDeps): Output {
  return new Output(mode, { stdout: deps.stdout, stderr: deps.stderr });
}

/**
 * Open a tunnel and hold it until the command is stopped.
 *
 * Ctrl-C is the documented way to end this command, so it exits 0 — the
 * interrupt is the user getting what they asked for, not a failure. A tunnel
 * the SERVICE disconnects is different: that is exit 10 (`UNAVAILABLE`), and
 * anything attached to it has already stopped working.
 */
export async function runTunnelStart(
  opts: TunnelStartOptions,
  deps: TunnelDeps = {},
): Promise<void> {
  const stdout = stdoutOf(deps);
  const stderr = stderrOf(deps);
  const out = makeOutput(opts.output, deps);

  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    out.print(
      {
        method: 'POST',
        path: '/api/cli/v1/tunnel',
        ...(opts.ttlSeconds !== undefined ? { body: { ttlSeconds: opts.ttlSeconds } } : {}),
        thenHold: 'until interrupted',
        thenDelete: '/api/cli/v1/tunnel/<client-id>',
      },
      () =>
        [
          'POST   /api/cli/v1/tunnel',
          'hold   until interrupted (Ctrl-C)',
          'DELETE /api/cli/v1/tunnel/<client-id>',
        ].join('\n'),
    );
    return;
  }

  const requestTimeoutMs = resolveRequestTimeoutMs(opts, deps.env ?? process.env);
  const clientOpts = { ...opts, requestTimeoutMs };
  const shutdown = deps.shutdown ?? globalShutdown;

  let fatal = false;
  let resolveWait: (() => void) | undefined;
  let session: Awaited<ReturnType<typeof openTunnelSession>> | undefined;
  const disarm = shutdown.arm();
  try {
    try {
      session = await openTunnelSession(
        {
          log: stderr,
          logLevel: opts.debug ? 'debug' : opts.verbose ? 'info' : 'error',
          ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
          onFatal: () => {
            fatal = true;
            resolveWait?.();
          },
        },
        {
          mint: async ttlSeconds =>
            withUninterruptibleRequest(clientOpts, deps, requestTimeoutMs, client =>
              client.mintTunnel({ ...(ttlSeconds ? { ttlSeconds } : {}) }),
            ),
          destroy: async clientId => deleteTunnelForCleanup(opts, deps, clientId),
          createClient: shutdownAwareTunnelClientFactory(
            deps.createTunnelClient ?? (options => new TunnelClient(options)),
            shutdown.signal,
          ),
        },
      );
    } catch (err) {
      // The session helper has already stopped the client and deleted a minted
      // binding. A first Ctrl-C during mint/connect is the command's documented
      // normal stop, so retain exit 0 instead of exposing its wrapped error.
      if (shutdown.signal.aborted) return;
      throw err;
    }

    out.print(
      { clientId: session.clientId, expiresAt: session.expiresAt, status: 'online' },
      data => {
        const d = data as { clientId: string; expiresAt: string };
        return [
          `clientId    ${d.clientId}`,
          `expiresAt   ${d.expiresAt}`,
          `status      online`,
          `hint        Attach a run: testsprite test run <test-id> --local <port> --tunnel-client ${d.clientId}`,
          `hint        Stop it:      Ctrl-C here (or: testsprite tunnel stop ${d.clientId})`,
        ].join('\n');
      },
    );
    void stdout;

    await new Promise<void>(resolve => {
      resolveWait = resolve;
      if (fatal || shutdown.signal.aborted) {
        resolve();
        return;
      }
      shutdown.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    try {
      await session?.close();
    } finally {
      disarm();
    }
  }

  if (fatal && !shutdown.signal.aborted) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'UNAVAILABLE',
        message: 'The tunnel service disconnected this client and it cannot be restored.',
        nextAction:
          'Start it again — the retry mints a fresh client. Any run attached to the old client ' +
          'has already stopped being able to reach this machine.',
        requestId: 'local',
        details: { reason: 'auth-failed', clientId: session.clientId },
      },
    });
  }
  stderr(`Tunnel ${session.clientId} closed.`);
}

/**
 * Is a client of mine connected?
 *
 * The reason this reads the way it does: `offline` is reported ONLY when the
 * API answered and said so. An unreachable API, a 5xx, or any transport
 * failure propagates as its own error — never as `offline`. Collapsing the two
 * sends someone to restart a tunnel that was never the problem, which is the
 * defect backend-v2.0 #1068 fixed on the server side of this same question.
 */
export async function runTunnelStatus(
  opts: TunnelClientIdOptions,
  deps: TunnelDeps = {},
): Promise<TunnelStatusResponse> {
  const out = makeOutput(opts.output, deps);
  if (opts.dryRun) {
    emitDryRunBanner(stderrOf(deps));
    const sample: TunnelStatusResponse = {
      clientId: opts.clientId,
      status: 'online',
      expiresAt: '2026-01-01T00:00:00.000Z',
    };
    out.print(sample, () => renderStatus(sample));
    return sample;
  }
  const status = await makeClient(opts, deps).getTunnelStatus(opts.clientId);
  out.print(status, data => renderStatus(data as TunnelStatusResponse));
  return status;
}

function renderStatus(status: TunnelStatusResponse): string {
  const lines = [
    `clientId    ${status.clientId}`,
    `status      ${status.status}`,
    `expiresAt   ${status.expiresAt}`,
  ];
  if (status.status !== 'online') {
    lines.push(
      'hint        Nothing is connected with this id. Start one with: testsprite tunnel start',
    );
  }
  return lines.join('\n');
}

/**
 * Destroy a binding. Idempotent by contract — deleting an unknown or
 * already-deleted binding is a success, because the requested end state holds.
 *
 * Worth knowing: this removes the ability to ATTACH a run to that client, and
 * removes the client from the tunnel server. It does not reach into a
 * `tunnel start` process still running elsewhere; stop that one with Ctrl-C.
 */
export async function runTunnelStop(
  opts: TunnelClientIdOptions,
  deps: TunnelDeps = {},
): Promise<void> {
  const out = makeOutput(opts.output, deps);
  if (opts.dryRun) {
    emitDryRunBanner(stderrOf(deps));
    out.print(
      { method: 'DELETE', path: `/api/cli/v1/tunnel/${opts.clientId}` },
      () => `DELETE /api/cli/v1/tunnel/${opts.clientId}`,
    );
    return;
  }
  await makeClient(opts, deps).deleteTunnel(opts.clientId);
  out.print({ clientId: opts.clientId, deleted: true }, () => `Tunnel ${opts.clientId} deleted.`);
}

export function createTunnelCommand(deps: TunnelDeps = {}): Command {
  const tunnel = new Command('tunnel')
    .description('Open a tunnel so TestSprite can reach an app on this machine')
    .addHelpText(
      'after',
      '\n`testsprite test run <id> --local <port>` opens and closes a tunnel for you for a single\n' +
        'run. Use these commands when you want one tunnel to serve several runs, or to check on\n' +
        'one that a run reported as down.\n' +
        '\nA tunnel lives only as long as `tunnel start` is running — there is no background\n' +
        'daemon, because the credential that authorises an inbound network path into this machine\n' +
        'is never written to disk.\n' +
        '\nExamples:\n' +
        '  testsprite tunnel start                                   # hold a tunnel open (Ctrl-C to stop)\n' +
        '  testsprite test run <id> --local 5173 --tunnel-client <id>\n' +
        '  testsprite tunnel status <id>\n' +
        '  testsprite tunnel stop <id>\n',
    );

  tunnel
    .command('start')
    // One-line description: Commander prints it in the parent's command list,
    // where an embedded newline breaks out of the indented column. The detail
    // belongs in this command's own help, below.
    .description('Open a tunnel and hold it until you stop the command (Ctrl-C)')
    .option(
      '--ttl <seconds>',
      'requested lifetime of the tunnel credential (60–28800). The server clamps this, and the ' +
        'credential is deleted when the command exits regardless — the lifetime only matters if ' +
        'this process is killed without cleaning up.',
    )
    .addHelpText(
      'after',
      '\nPrints the client id to pass to `test run --local <port> --tunnel-client <id>`.\n' +
        '\nExit codes:\n' +
        '  0  you stopped it (Ctrl-C is the normal way to end this command)\n' +
        '  3  auth error — the key needs the `run:tunnel` scope; mint a new key\n' +
        ' 10  the tunnel service disconnected the client, or it never connected\n' +
        ' 11  rate limited, or too many tunnels are already open for this account\n',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: { ttl?: string }, command: Command) => {
      const ttlSeconds = parseTtl(cmdOpts.ttl);
      await runTunnelStart(
        {
          ...resolveCommonOptions(command),
          ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
        },
        deps,
      );
    });

  tunnel
    .command('status <client-id>')
    .description('Report whether a tunnel client of yours is connected')
    .addHelpText(
      'after',
      '\n`offline` means the API answered and said nothing is connected with that id. A failure\n' +
        'to reach TestSprite is reported as its own error, never as `offline`.\n' +
        '\nExit codes:\n' +
        '  0  answered (the answer may be `offline`)\n' +
        '  4  no such tunnel for this account\n' +
        ' 10  could not reach TestSprite to ask\n',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (clientId: string, _cmdOpts: unknown, command: Command) => {
      await runTunnelStatus({ ...resolveCommonOptions(command), clientId }, deps);
    });

  tunnel
    .command('stop <client-id>')
    .description('Destroy a tunnel credential (idempotent)')
    .addHelpText(
      'after',
      '\nStopping one that is already gone succeeds. This revokes the credential; it does not\n' +
        'stop a `tunnel start` still running in another terminal (press Ctrl-C there).\n',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (clientId: string, _cmdOpts: unknown, command: Command) => {
      await runTunnelStop({ ...resolveCommonOptions(command), clientId }, deps);
    });

  return tunnel;
}

function resolveCommonOptions(command: Command): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & {
    requestTimeout?: string;
  };
  return {
    profile: globals.profile ?? 'default',
    output: resolveOutputMode(globals.output),
    endpointUrl: globals.endpointUrl,
    debug: globals.debug ?? false,
    verbose: globals.verbose ?? false,
    dryRun: globals.dryRun ?? false,
    requestTimeoutMs: parseRequestTimeoutFlag(globals.requestTimeout),
  };
}

function parseTtl(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request.',
        nextAction: 'Flag `--ttl` is invalid: must be a positive whole number of seconds.',
        requestId: 'local',
        details: { field: 'ttl', reason: 'must be a positive whole number of seconds' },
      },
    });
  }
  return n;
}
