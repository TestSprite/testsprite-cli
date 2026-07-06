/**
 * P10 — unit tests for `rephraseUnknownOption`.
 *
 * Commander emits "error: unknown option '--foo'" when an unknown flag is
 * encountered. If `--foo` is a known global flag placed after a subcommand,
 * we rephrase the message to guide the user to move the flag before the
 * subcommand name.
 */
import { describe, expect, it } from 'vitest';
import { renderCommanderError, rephraseUnknownOption } from './render-error.js';

describe('rephraseUnknownOption', () => {
  it('rephrases --dry-run placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--dry-run'");
    expect(result).not.toBeNull();
    expect(result).toContain('--dry-run');
    expect(result).toContain('global flag');
    expect(result).toContain('before the subcommand');
  });

  it('rephrases --output placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--output'");
    expect(result).not.toBeNull();
    expect(result).toContain('--output');
    expect(result).toContain('Example:');
  });

  it('rephrases --profile placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--profile'");
    expect(result).not.toBeNull();
    expect(result).toContain('--profile');
  });

  it('rephrases --endpoint-url placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--endpoint-url'");
    expect(result).not.toBeNull();
    expect(result).toContain('--endpoint-url');
  });

  it('rephrases --request-timeout placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--request-timeout'");
    expect(result).not.toBeNull();
    expect(result).toContain('--request-timeout');
  });

  it('rephrases --debug placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--debug'");
    expect(result).not.toBeNull();
    expect(result).toContain('--debug');
  });

  it('rephrases --verbose placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--verbose'");
    expect(result).not.toBeNull();
    expect(result).toContain('--verbose');
  });

  it('returns null for a non-global unknown flag (--foo)', () => {
    const result = rephraseUnknownOption("error: unknown option '--foo'");
    expect(result).toBeNull();
  });

  it('returns null for a completely unrelated string', () => {
    const result = rephraseUnknownOption('something else entirely');
    expect(result).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(rephraseUnknownOption('')).toBeNull();
  });

  it('example text includes the flag name in the usage hint', () => {
    const result = rephraseUnknownOption("error: unknown option '--dry-run'");
    expect(result).not.toBeNull();
    expect(result).toContain('testsprite --dry-run');
  });

  it('boolean flag (--dry-run) example does NOT include a <value> placeholder', () => {
    const result = rephraseUnknownOption("error: unknown option '--dry-run'");
    expect(result).not.toBeNull();
    expect(result).not.toContain('<value>');
    expect(result).toContain('testsprite --dry-run <subcommand>');
  });

  it('value flag (--output) example DOES include a <value> placeholder', () => {
    const result = rephraseUnknownOption("error: unknown option '--output'");
    expect(result).not.toBeNull();
    expect(result).toContain('testsprite --output <value> <subcommand>');
  });

  it('value flag (--endpoint-url) example DOES include a <value> placeholder', () => {
    const result = rephraseUnknownOption("error: unknown option '--endpoint-url'");
    expect(result).not.toBeNull();
    expect(result).toContain('testsprite --endpoint-url <value> <subcommand>');
  });

  it('value flag (--request-timeout) example DOES include a <value> placeholder', () => {
    const result = rephraseUnknownOption("error: unknown option '--request-timeout'");
    expect(result).not.toBeNull();
    expect(result).toContain('testsprite --request-timeout <value> <subcommand>');
  });
});

describe('renderCommanderError', () => {
  it('json mode: emits VALIDATION_ERROR envelope', () => {
    const out = renderCommanderError("error: unknown command 'foo'\n", 'fallback', 'json');
    const parsed = JSON.parse(out) as {
      error: { code: string; message: string; requestId: string; nextAction: string };
    };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.message).toBe("error: unknown command 'foo'");
    expect(parsed.error.requestId).toBe('local');
    expect(typeof parsed.error.nextAction).toBe('string');
    expect(parsed.error.nextAction.length).toBeGreaterThan(0);
  });

  it('json mode: uses fallback when pendingMsg is null', () => {
    const out = renderCommanderError(null, 'missing required argument', 'json');
    const parsed = JSON.parse(out) as { error: { message: string } };
    expect(parsed.error.message).toBe('missing required argument');
  });

  it('json mode: trims trailing newline from message', () => {
    const out = renderCommanderError('error: bad option\n', 'bad', 'json');
    const parsed = JSON.parse(out) as { error: { message: string } };
    expect(parsed.error.message).toBe('error: bad option');
  });

  it('json mode: output is valid JSON ending with newline', () => {
    const out = renderCommanderError('error: something', 'fallback', 'json');
    expect(out.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('text mode: returns pendingMsg as-is', () => {
    const out = renderCommanderError('error: bad command\n', 'bad', 'text');
    expect(out).toBe('error: bad command\n');
  });

  it('text mode: synthesizes from fallback when pendingMsg is null', () => {
    const out = renderCommanderError(null, 'missing required argument', 'text');
    expect(out).toContain('missing required argument');
  });

  it('json mode: rephrased global-flag message is embedded in envelope', () => {
    const rephrased = rephraseUnknownOption("error: unknown option '--output'")!;
    const out = renderCommanderError(`${rephrased}\n`, 'unknown option', 'json');
    const parsed = JSON.parse(out) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.message).toContain('--output');
    expect(parsed.error.message).toContain('global flag');
  });

  it('json mode: envelope has exactly the expected top-level key', () => {
    const out = renderCommanderError('error: test', 'test', 'json');
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['error']);
  });
});
