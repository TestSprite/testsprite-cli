import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Output, isOutputMode, resolveOutputMode } from './output.js';
import { ApiError } from './errors.js';

describe('isOutputMode', () => {
  it('accepts json and text', () => {
    expect(isOutputMode('json')).toBe(true);
    expect(isOutputMode('text')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isOutputMode('yaml')).toBe(false);
    expect(isOutputMode(undefined)).toBe(false);
    expect(isOutputMode(null)).toBe(false);
    expect(isOutputMode(42)).toBe(false);
  });
});

describe('resolveOutputMode', () => {
  it('returns the mode verbatim for valid values', () => {
    expect(resolveOutputMode('json')).toBe('json');
    expect(resolveOutputMode('text')).toBe('text');
  });

  it('defaults to text when the flag is omitted (undefined)', () => {
    expect(resolveOutputMode(undefined)).toBe('text');
  });

  it('throws a typed VALIDATION_ERROR (exit 5) instead of silently falling back to text', () => {
    // The footgun this guards against: an agent that asks for `--output json`
    // but mistypes it would otherwise receive a text payload and fail to parse
    // it as JSON with no signal. Every command group must reject, not coerce.
    for (const bad of ['josn', 'yaml', 'JSON', 'Text', '']) {
      let caught: unknown;
      try {
        resolveOutputMode(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      const apiErr = caught as ApiError;
      expect(apiErr.code).toBe('VALIDATION_ERROR');
      expect(apiErr.exitCode).toBe(5);
      expect(apiErr.nextAction).toContain('must be one of: json, text');
    }
  });
});

describe('Output', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('prints JSON when mode is json', () => {
    new Output('json').print({ hello: 'world' });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ hello: 'world' }, null, 2));
  });

  it('prefers JSON in json mode even when a text renderer is provided', () => {
    new Output('json').print({ a: 1 }, () => 'rendered');
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2));
  });

  it('uses text renderer when mode is text', () => {
    new Output('text').print({ a: 1 }, () => 'rendered');
    expect(logSpy).toHaveBeenCalledWith('rendered');
  });

  it('falls back to JSON when text mode has no renderer', () => {
    new Output('text').print({ x: 1 });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ x: 1 }, null, 2));
  });

  it('error in json mode emits a structured {code,message} envelope to stderr', () => {
    new Output('json').error({ code: 'CLI_ERROR', message: 'boom' });
    expect(errorSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          error: {
            code: 'CLI_ERROR',
            message: 'boom',
            nextAction: '',
            requestId: 'local',
            details: {},
          },
        },
        null,
        2,
      ),
    );
  });

  it('error in text mode emits prefixed text to stderr (code is not shown)', () => {
    new Output('text').error({ code: 'CLI_ERROR', message: 'boom' });
    expect(errorSpy).toHaveBeenCalledWith('Error: boom');
  });

  it('defaults to text mode', () => {
    new Output().error({ code: 'CLI_ERROR', message: 'boom' });
    expect(errorSpy).toHaveBeenCalledWith('Error: boom');
  });

  // Contract test: every `--output json` error branch in
  // index.ts's catch (ApiError, InterruptError, RequestTimeoutError,
  // CLIError, and the uncaught-exception fallback) must render the SAME
  // 5-key envelope shape `{error:{code,message,nextAction,requestId,details}}`
  // — never a bare string. Before this patch, Output.error() only accepted a
  // plain message string and emitted `{"error":"<message>"}`, which is why
  // the CLIError/uncaught-exception branches in index.ts (the only two
  // callers of this method) broke the contract that the ApiError/
  // InterruptError/RequestTimeoutError branches (which build their own
  // envelopes by hand) already followed.
  describe('error() envelope shape contract', () => {
    it.each([
      { code: 'CLI_ERROR', message: 'boom' },
      { code: 'UNCAUGHT_EXCEPTION', message: 'ENOENT: no such file' },
      { code: 'ENOENT', message: 'no such file' },
    ])('always emits the full 5-key envelope for %j', input => {
      new Output('json').error(input);
      const written = errorSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(written) as { error: Record<string, unknown> };
      expect(Object.keys(parsed.error).sort()).toEqual(
        ['code', 'details', 'message', 'nextAction', 'requestId'].sort(),
      );
      expect(parsed.error.code).toBe(input.code);
      expect(parsed.error.message).toBe(input.message);
      expect(parsed.error.nextAction).toBe('');
      expect(parsed.error.requestId).toBe('local');
      expect(parsed.error.details).toEqual({});
    });

    it('honors explicit nextAction / requestId / details overrides', () => {
      new Output('json').error({
        code: 'VALIDATION_ERROR',
        message: 'bad flag',
        nextAction: 'fix the flag',
        requestId: 'req_123',
        details: { field: 'x' },
      });
      const written = errorSpy.mock.calls[0]?.[0] as string;
      expect(JSON.parse(written)).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'bad flag',
          nextAction: 'fix the flag',
          requestId: 'req_123',
          details: { field: 'x' },
        },
      });
    });
  });
});

describe('Output.writeChunk — backpressure', () => {
  it('forwards the chunk to a sync rawStdout writer', async () => {
    const chunks: string[] = [];
    const out = new Output('text', {
      rawStdout: chunk => {
        chunks.push(chunk);
      },
    });
    await out.writeChunk('hello ');
    await out.writeChunk('world');
    expect(chunks).toEqual(['hello ', 'world']);
  });

  it('awaits a Promise-returning rawStdout writer before resolving', async () => {
    // The presigned-stream loop relies on this: when stdout's kernel
    // buffer is full, the rawStdout writer returns a Promise that
    // resolves on `'drain'`. The reader must pause until that
    // resolves, otherwise chunks pile up in V8's heap and the
    // streaming guarantee silently degrades.
    let resolveDrain: (() => void) | undefined;
    const drainPromise = new Promise<void>(resolve => {
      resolveDrain = resolve;
    });
    const out = new Output('text', {
      rawStdout: () => drainPromise,
    });
    let writeResolved = false;
    const writePromise = out.writeChunk('payload').then(() => {
      writeResolved = true;
    });
    // Yield to the microtask queue. If writeChunk didn't await the
    // returned Promise, writeResolved would already be true here.
    await new Promise(r => setImmediate(r));
    expect(writeResolved).toBe(false);
    resolveDrain!();
    await writePromise;
    expect(writeResolved).toBe(true);
  });
});
