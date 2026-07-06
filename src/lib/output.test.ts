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

  it('error in json mode emits structured JSON to stderr', () => {
    new Output('json').error('boom');
    expect(errorSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'boom' }, null, 2));
  });

  it('error in text mode emits prefixed text to stderr', () => {
    new Output('text').error('boom');
    expect(errorSpy).toHaveBeenCalledWith('Error: boom');
  });

  it('defaults to text mode', () => {
    new Output().error('boom');
    expect(errorSpy).toHaveBeenCalledWith('Error: boom');
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
