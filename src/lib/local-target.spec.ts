import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { ApiError } from './errors.js';
import {
  LOOPBACK_HOSTS,
  assertLocalPortListening,
  buildLocalTargetUrl,
  normalizeLocalHost,
  parseLocalPort,
  probeLocalPort,
} from './local-target.js';

/**
 * The probe is exercised against REAL sockets, not an injected connect stub.
 * The whole reason this module exists rather than reusing
 * `target-url-preflight.ts` is that the run-time dial is a raw `net.connect`
 * from this process — a stub would let the probe and the real dial drift apart
 * silently, which is exactly the class of bug the pre-charge guarantee cannot
 * afford.
 */
const servers: net.Server[] = [];

async function listenOnLoopback(host: string): Promise<number> {
  const server = net.createServer(socket => socket.end());
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/** A port nothing listens on: bind, read the port, then close. */
async function closedLoopbackPort(host: string): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))),
  );
});

describe('parseLocalPort', () => {
  it('accepts a plain port', () => {
    expect(parseLocalPort('5173')).toBe(5173);
    expect(parseLocalPort('1')).toBe(1);
    expect(parseLocalPort('65535')).toBe(65535);
  });

  it.each(['0', '65536', '-1', '5173.5', 'abc', '', ' 5173', '5173 '])(
    'rejects %j with a VALIDATION_ERROR naming --local',
    raw => {
      let thrown: unknown;
      try {
        parseLocalPort(raw);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      const err = thrown as ApiError;
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.getDetail('field', (v): v is string => typeof v === 'string')).toBe('local');
    },
  );
});

describe('normalizeLocalHost', () => {
  it('defaults to 127.0.0.1', () => {
    expect(normalizeLocalHost(undefined)).toBe('127.0.0.1');
  });

  it.each([
    ['localhost', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['[::1]', '::1'],
  ])('accepts %j -> %j', (raw, expected) => {
    expect(normalizeLocalHost(raw)).toBe(expected);
  });

  /**
   * The accepted set must equal the server's `isLoopbackString`
   * (backend-v2.0 `libs/net/private-address.ts`) exactly: anything the CLI
   * accepts but the server rejects becomes a `tunnel-target-not-local` 400
   * AFTER the mint, and anything the CLI rejects but the server accepts is a
   * capability we silently withhold. `127.0.0.2` is the case that proves the
   * rule is the literal set, not "in 127.0.0.0/8".
   */
  it.each(['127.0.0.2', '0.0.0.0', 'host.docker.internal', '10.0.0.5', 'example.com', '::'])(
    'rejects %j client-side',
    raw => {
      let thrown: unknown;
      try {
        normalizeLocalHost(raw);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).code).toBe('VALIDATION_ERROR');
      expect(
        (thrown as ApiError).getDetail('field', (v): v is string => typeof v === 'string'),
      ).toBe('local-host');
    },
  );

  it('exposes exactly the three server-side loopback spellings', () => {
    expect([...LOOPBACK_HOSTS]).toEqual(['localhost', '127.0.0.1', '::1']);
  });
});

describe('buildLocalTargetUrl', () => {
  it('brackets an IPv6 literal and leaves the other two alone', () => {
    expect(buildLocalTargetUrl('127.0.0.1', 5173)).toBe('http://127.0.0.1:5173');
    expect(buildLocalTargetUrl('localhost', 5173)).toBe('http://localhost:5173');
    expect(buildLocalTargetUrl('::1', 5173)).toBe('http://[::1]:5173');
  });

  it('produces a URL whose hostname the server-side loopback check will accept', () => {
    for (const host of LOOPBACK_HOSTS) {
      const parsed = new URL(buildLocalTargetUrl(host, 3000));
      const bare =
        parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
          ? parsed.hostname.slice(1, -1)
          : parsed.hostname;
      expect(['localhost', '127.0.0.1', '::1']).toContain(bare.toLowerCase());
    }
  });
});

describe('probeLocalPort', () => {
  it('is ok when something is listening', async () => {
    const port = await listenOnLoopback('127.0.0.1');
    await expect(probeLocalPort('127.0.0.1', port)).resolves.toEqual({ verdict: 'ok' });
  });

  it('is ok for `localhost` when only the IPv4 candidate is listening', async () => {
    // `resolveDialCandidates('localhost')` yields BOTH 127.0.0.1 and ::1; a dev
    // server bound to one family must not be reported as dead because the other
    // refused. This is the single most likely false refusal on this path.
    const port = await listenOnLoopback('127.0.0.1');
    await expect(probeLocalPort('localhost', port)).resolves.toEqual({ verdict: 'ok' });
  });

  it('refuses when nothing is listening', async () => {
    const port = await closedLoopbackPort('127.0.0.1');
    const outcome = await probeLocalPort('127.0.0.1', port);
    expect(outcome.verdict).toBe('refuse');
    expect(outcome.verdict === 'refuse' && outcome.reason).toMatch(/no candidate connected/i);
  });

  it('refuses when resolution produces no dial candidates', async () => {
    const outcome = await probeLocalPort('localhost', 5173, {
      resolveCandidates: async () => [],
    });

    expect(outcome.verdict).toBe('refuse');
    expect(outcome.verdict === 'refuse' && outcome.reason).toContain('localhost:5173');
    expect(outcome.verdict === 'refuse' && outcome.reason).toMatch(/no dial candidates/i);
  });

  it('refuses when every dial candidate times out and reports every attempt', async () => {
    const outcome = await probeLocalPort('localhost', 5173, {
      resolveCandidates: async () => [
        { host: '127.0.0.1', port: 5173 },
        { host: '::1', port: 5173 },
      ],
      connect: async () => {
        const err = new Error('connect timed out') as NodeJS.ErrnoException;
        err.code = 'ETIMEDOUT';
        throw err;
      },
    });

    expect(outcome.verdict).toBe('refuse');
    expect(outcome.verdict === 'refuse' && outcome.reason).toContain('127.0.0.1:5173 -> ETIMEDOUT');
    expect(outcome.verdict === 'refuse' && outcome.reason).toContain('[::1]:5173 -> ETIMEDOUT');
  });

  it('refuses a mixture of refused and timed-out candidates and reports both', async () => {
    const outcome = await probeLocalPort('localhost', 5173, {
      resolveCandidates: async () => [
        { host: '127.0.0.1', port: 5173 },
        { host: '::1', port: 5173 },
      ],
      connect: async host => {
        const err = new Error('connect failed') as NodeJS.ErrnoException;
        err.code = host === '127.0.0.1' ? 'ECONNREFUSED' : 'ETIMEDOUT';
        throw err;
      },
    });

    expect(outcome.verdict).toBe('refuse');
    expect(outcome.verdict === 'refuse' && outcome.reason).toContain(
      '127.0.0.1:5173 -> ECONNREFUSED',
    );
    expect(outcome.verdict === 'refuse' && outcome.reason).toContain('[::1]:5173 -> ETIMEDOUT');
  });
});

describe('assertLocalPortListening', () => {
  it('throws before anything is minted when the port is dead', async () => {
    const port = await closedLoopbackPort('127.0.0.1');
    const lines: string[] = [];
    let thrown: unknown;
    try {
      await assertLocalPortListening('127.0.0.1', port, {}, line => lines.push(line));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const err = thrown as ApiError;
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.getDetail('reason', (v): v is string => typeof v === 'string')).toBe(
      'local-port-not-listening',
    );
  });

  it('names --skip-preflight exactly once (DEV-933)', async () => {
    const port = await closedLoopbackPort('127.0.0.1');
    let thrown: ApiError | undefined;
    try {
      await assertLocalPortListening('127.0.0.1', port, {}, () => {});
    } catch (err) {
      thrown = err as ApiError;
    }
    const text = `${thrown?.message ?? ''} ${thrown?.nextAction ?? ''}`;
    expect(text.match(/--skip-preflight/g)?.length).toBe(1);
  });

  it('makes ZERO connection attempts under --skip-preflight', async () => {
    // A closed port would otherwise refuse; skipping must not even look.
    const port = await closedLoopbackPort('127.0.0.1');
    let attempts = 0;
    await expect(
      assertLocalPortListening('127.0.0.1', port, { skipPreflight: true }, () => {}, {
        connect: async () => {
          attempts += 1;
        },
      }),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(0);
  });

  it('passes silently when the port is live', async () => {
    const port = await listenOnLoopback('127.0.0.1');
    const lines: string[] = [];
    await expect(
      assertLocalPortListening('127.0.0.1', port, {}, line => lines.push(line)),
    ).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });
});
