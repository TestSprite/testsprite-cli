import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { InterruptError } from './errors.js';
import {
  SIGINT_EXIT_CODE,
  ShutdownController,
  TERMINATION_EXIT_CODES,
  formatInterruptMessage,
  installBrokenPipeGuard,
  installSignalHandlers,
} from './interrupt.js';

// installSignalHandlers' default stderr writes via fs.writeSync (synchronous, so
// the hint survives a piped stderr before exit); mock it to assert on that path.
vi.mock('node:fs', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, writeSync: vi.fn() };
});

describe('formatInterruptMessage', () => {
  it('defaults to SIGINT and explains the run continues server-side', () => {
    const message = formatInterruptMessage();
    expect(message).toContain('Interrupted (SIGINT)');
    expect(message).toContain('test wait');
    expect(message).toContain('test list');
  });

  it('names the specific signal when given one', () => {
    expect(formatInterruptMessage('SIGTERM')).toContain('Interrupted (SIGTERM)');
    expect(formatInterruptMessage('SIGHUP')).toContain('Interrupted (SIGHUP)');
  });
});

/** Fresh handler map + controller per case: the disarmed path exits on the
 *  FIRST signal, so sequential signals on one install take the second-signal
 *  hard-exit branch (by design — DEV-331 SIG-5). */
function install(shutdown = new ShutdownController()) {
  const handlers = new Map<string, () => void>();
  const stderr: string[] = [];
  const exit = vi.fn();
  installSignalHandlers({
    on: (signal, handler) => handlers.set(signal, handler),
    stderr: line => stderr.push(line),
    exit,
    shutdown,
  });
  return { handlers, stderr, exit, shutdown };
}

describe('installSignalHandlers', () => {
  it('registers SIGINT, SIGTERM and SIGHUP with the conventional 128+signum exit codes', () => {
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const) {
      const { handlers, stderr, exit } = install();
      expect([...handlers.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
      handlers.get(signal)!();
      expect(exit).toHaveBeenLastCalledWith(code);
      // Disarmed handler emits a leading blank line then the explanation.
      expect(stderr[0]).toBe('');
      expect(stderr.join('\n')).toContain(`Interrupted (${signal})`);
    }
    expect(SIGINT_EXIT_CODE).toBe(130);
    expect(TERMINATION_EXIT_CODES.SIGTERM).toBe(143);
    expect(TERMINATION_EXIT_CODES.SIGHUP).toBe(129);
  });

  it('writes the hint synchronously via writeSync before exit (survives a piped stderr)', () => {
    vi.mocked(writeSync).mockClear();
    const handlers = new Map<string, () => void>();
    const exit = vi.fn();
    // No stderr dep: exercise the synchronous default path.
    installSignalHandlers({
      on: (signal, handler) => handlers.set(signal, handler),
      exit,
      shutdown: new ShutdownController(),
    });
    handlers.get('SIGINT')!();
    expect(exit).toHaveBeenCalledWith(130);
    const written = vi
      .mocked(writeSync)
      .mock.calls.map(call => String(call[1]))
      .join('');
    expect(written).toContain('Interrupted (SIGINT)');
  });

  it('armed scope: first signal aborts with InterruptError and does NOT exit or print', () => {
    const { handlers, stderr, exit, shutdown } = install();
    const disarm = shutdown.arm();
    handlers.get('SIGINT')!();

    expect(exit).not.toHaveBeenCalled();
    expect(stderr).toEqual([]);
    expect(shutdown.signal.aborted).toBe(true);
    expect(shutdown.received).toBe('SIGINT');
    const reason = shutdown.signal.reason as InterruptError;
    expect(reason).toBeInstanceOf(InterruptError);
    expect(reason.signal).toBe('SIGINT');
    expect(reason.exitCode).toBe(130);
    disarm();
  });

  it('second signal exits immediately when nothing is armed and nothing is registered', () => {
    // Disarmed: the first signal already exited, so a repeat has nothing to
    // protect and must not introduce any delay at all.
    const { handlers, exit } = install();
    handlers.get('SIGINT')!();
    expect(exit).toHaveBeenCalledWith(130);
    handlers.get('SIGTERM')!();
    expect(exit).toHaveBeenLastCalledWith(143);
  });

  it('second signal waits for critical cleanup registered AFTER it arrived', async () => {
    // The window this covers is the likely case, not a rare one: teardown has
    // to unwind the poll loop before it can issue the credential delete, and a
    // reflexive double Ctrl-C lands inside that gap. Judging "is there anything
    // to protect?" only from what is already registered answers no, hard-exits,
    // and strands a live inbound credential until its TTL.
    const { handlers, exit, shutdown } = install();
    const disarm = shutdown.arm();
    handlers.get('SIGINT')!();
    expect(exit).not.toHaveBeenCalled();

    handlers.get('SIGTERM')!();
    expect(exit).not.toHaveBeenCalled();

    // Registered a tick later, exactly as real teardown does.
    let deleted = false;
    await new Promise(resolve => setTimeout(resolve, 20));
    const critical = shutdown.runCriticalOperation(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      deleted = true;
    });
    expect(exit).not.toHaveBeenCalled();

    await critical;
    // The real command releases the lifecycle scope once the delete returns.
    disarm();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    expect(deleted).toBe(true);
  });

  it('second signal does not hang when armed teardown never registers anything', async () => {
    // The settle window must be bounded: an ordinary --wait detach registers no
    // critical work, and the escape hatch has to stay an escape hatch.
    const { handlers, exit, shutdown } = install();
    shutdown.arm();
    const startedAt = Date.now();
    handlers.get('SIGINT')!();
    handlers.get('SIGTERM')!();
    // Never disarmed and nothing registered: the 2s cap is the only thing that
    // can end this, and it must.
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143), { timeout: 5_000 });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it('second signal waits for a registered critical operation to finish before exiting', async () => {
    const { handlers, exit, shutdown } = install();
    const disarmLifecycle = shutdown.arm();
    let resolveCritical!: () => void;
    let completed = false;
    const gate = new Promise<void>(resolve => {
      resolveCritical = resolve;
    });
    const critical = shutdown.runCriticalOperation(async () => {
      await gate;
      completed = true;
    });

    handlers.get('SIGINT')!();
    handlers.get('SIGTERM')!();
    expect(exit).not.toHaveBeenCalled();

    resolveCritical();
    await critical;
    disarmLifecycle();
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(completed).toBe(true);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('second signal exits at the 2000 ms cap when a critical operation never finishes', async () => {
    vi.useFakeTimers();
    try {
      const { handlers, exit, shutdown } = install();
      shutdown.arm();
      void shutdown.runCriticalOperation(() => new Promise<void>(() => {}));

      handlers.get('SIGINT')!();
      handlers.get('SIGTERM')!();
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_999);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(exit).toHaveBeenCalledWith(143);
    } finally {
      vi.useRealTimers();
    }
  });

  it('third signal exits immediately even while critical-operation grace is active', async () => {
    vi.useFakeTimers();
    try {
      const { handlers, exit, shutdown } = install();
      shutdown.arm();
      void shutdown.runCriticalOperation(() => new Promise<void>(() => {}));

      handlers.get('SIGINT')!();
      handlers.get('SIGTERM')!();
      expect(exit).not.toHaveBeenCalled();

      handlers.get('SIGHUP')!();
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(129);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposed scope reverts to the disarmed immediate-exit behavior', () => {
    const { handlers, stderr, exit, shutdown } = install();
    const disarm = shutdown.arm();
    disarm();
    disarm(); // idempotent — double dispose must not underflow the counter
    handlers.get('SIGTERM')!();
    expect(exit).toHaveBeenCalledWith(143);
    expect(stderr.join('\n')).toContain('Interrupted (SIGTERM)');
  });

  it('nested arms (fan-out members) stay armed until the last disposer runs', () => {
    const shutdown = new ShutdownController();
    const a = shutdown.arm();
    const b = shutdown.arm();
    a();
    expect(shutdown.isArmed).toBe(true);
    b();
    expect(shutdown.isArmed).toBe(false);
  });
});

describe('installBrokenPipeGuard', () => {
  function makeEpipe(): NodeJS.ErrnoException {
    return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  }

  it('exits 0 on stdout EPIPE (clean SIGPIPE-equivalent for `| head`)', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    const shutdown = new ShutdownController();
    installBrokenPipeGuard({ stdout, stderr, exit, shutdown });

    stdout.emit('error', makeEpipe());
    expect(exit).toHaveBeenCalledWith(0);
    expect(shutdown.signal.aborted).toBe(false);
  });

  it('armed scope: stdout EPIPE requests graceful cleanup instead of exiting immediately', async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    const shutdown = new ShutdownController();
    const disarm = shutdown.arm();
    const cleanup = vi.fn();
    const lifetime = new Promise<void>(resolve => {
      shutdown.signal.addEventListener(
        'abort',
        () => {
          queueMicrotask(() => {
            cleanup();
            disarm();
            resolve();
          });
        },
        { once: true },
      );
    });
    installBrokenPipeGuard({ stdout, stderr, exit, shutdown });

    stdout.emit('error', makeEpipe());

    expect(exit).not.toHaveBeenCalled();
    expect(shutdown.signal.aborted).toBe(true);
    const reason = shutdown.signal.reason as InterruptError;
    expect(reason).toBeInstanceOf(InterruptError);
    expect(reason.exitCode).toBe(0);
    await lifetime;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(shutdown.isArmed).toBe(false);
  });

  it('re-throws a non-EPIPE stdout error instead of silently swallowing it', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    installBrokenPipeGuard({ stdout, stderr, exit });

    expect(() =>
      stdout.emit('error', Object.assign(new Error('boom'), { code: 'ENOSPC' })),
    ).toThrow('boom');
    expect(exit).not.toHaveBeenCalled();
  });

  it('swallows stderr EPIPE without exiting or throwing', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    installBrokenPipeGuard({ stdout, stderr, exit });

    expect(() => stderr.emit('error', makeEpipe())).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
  });
});
