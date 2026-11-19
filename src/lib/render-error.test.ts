/**
 * P10 — unit tests for `rephraseUnknownOption`.
 *
 * Commander emits "error: unknown option '--foo'" when an unknown flag is
 * encountered. If `--foo` is a known global flag placed after a subcommand,
 * we rephrase the message to guide the user to move the flag before the
 * subcommand name.
 */
import { describe, expect, it } from 'vitest';
import { InterruptError } from './errors.js';
import {
  buildInterruptEnvelope,
  markRunWaitInterrupt,
  renderAmbiguousOrgCandidates,
  renderTunnelBindingLimitIds,
  redactUnknownOptionValue,
  renderCommanderError,
  rephraseUnknownOption,
} from './render-error.js';

describe('buildInterruptEnvelope (JSON-mode INTERRUPTED envelope)', () => {
  it('interrupted run wait: the run-detach story with the signal', () => {
    const err = new InterruptError('SIGINT');
    err.runWaitContext = true;
    const env = buildInterruptEnvelope(err);
    expect(env.error.code).toBe('INTERRUPTED');
    expect(env.error.message).toBe('Interrupted by SIGINT.');
    expect(env.error.nextAction).toContain(
      'Re-attach with: testsprite run wait <run-id>, or stop it with: testsprite run cancel <run-id> ',
    );
    expect(env.error.requestId).toBe('local');
    expect(env.error.details).toEqual({ signal: 'SIGINT' });
  });

  it('interrupted non-wait request: the generic check-state hint, no run story', () => {
    const env = buildInterruptEnvelope(new InterruptError('SIGINT'));
    expect(env.error.nextAction).toBe(
      'The request was interrupted. Check the current state before retrying; ' +
        'a multi-item command may have processed some items.',
    );
    expect(env.error.nextAction).not.toContain('run wait');
    expect(env.error.details).toEqual({ signal: 'SIGINT' });
  });

  it('interrupted run wait: says where the runId is without promising one', () => {
    const err = new InterruptError('SIGINT');
    err.runWaitContext = true;
    // An older backend names no launch, so the partial has a resultId only.
    expect(buildInterruptEnvelope(err).error.nextAction).toContain(
      'the partial JSON on stdout carries the runId when the backend reports one',
    );
  });

  it('interrupted run wait with known launches: the hint names them', () => {
    const err = new InterruptError('SIGINT');
    markRunWaitInterrupt(err, [
      { resultId: 'r1', runId: 'e1' },
      { resultId: 'r2', runId: 'e1' },
    ]);
    expect(err.runWaitContext).toBe(true);
    expect(buildInterruptEnvelope(err).error.nextAction).toBe(
      'The server-side run keeps executing and billing. ' +
        'Re-attach with: testsprite run wait e1, or stop it with: testsprite run cancel e1.',
    );
  });

  it('interrupted wait on a run this command joined: the cancel hint says what it stops', () => {
    const err = new InterruptError('SIGINT');
    markRunWaitInterrupt(err, [
      { resultId: 'r1', runId: 'e1' },
      { resultId: 'r9', runId: 'e9', joined: true },
    ]);
    expect(buildInterruptEnvelope(err).error.nextAction).toBe(
      'The server-side run keeps executing and billing. ' +
        'Re-attach with: testsprite run wait e1 e9, or stop it with: testsprite run cancel e1 e9 ' +
        '(cancelling e9 stops every test in that run, which this command joined and did not start).',
    );
  });

  it('interrupted run wait with no launch known: the generic hint, no result id in a command', () => {
    const err = new InterruptError('SIGINT');
    markRunWaitInterrupt(err, [{ resultId: 'r1' }]);
    const { nextAction } = buildInterruptEnvelope(err).error;
    expect(nextAction).toContain('testsprite run wait <run-id>');
    expect(nextAction).not.toContain('<runId>');
    expect(nextAction).not.toContain('r1');
  });

  it('tunnel detach attached: its nextAction wins; details name the launch and the result', () => {
    const err = new InterruptError('SIGINT');
    (err as InterruptError & { tunnelDetach?: unknown }).tunnelDetach = {
      resultId: 'run_1',
      runId: 'exec_1',
      cancel: 'cancelled',
      nextAction: 'Tunnel story.',
    };
    const env = buildInterruptEnvelope(err);
    expect(env.error.nextAction).toBe('Tunnel story.');
    expect(env.error.details).toEqual({
      signal: 'SIGINT',
      runId: 'exec_1',
      resultId: 'run_1',
      cancelOutcome: 'cancelled',
    });
  });

  it('tunnel detach from an older backend: resultId only', () => {
    const err = new InterruptError('SIGINT');
    (err as InterruptError & { tunnelDetach?: unknown }).tunnelDetach = {
      resultId: 'run_1',
      cancel: 'cancelled',
      nextAction: 'Tunnel story.',
    };
    expect(buildInterruptEnvelope(err).error.details).toEqual({
      signal: 'SIGINT',
      resultId: 'run_1',
      cancelOutcome: 'cancelled',
    });
  });

  it('precedence: a tunnel detach beats a run wait', () => {
    const err = new InterruptError('SIGINT');
    err.runWaitContext = true;
    (err as InterruptError & { tunnelDetach?: unknown }).tunnelDetach = {
      resultId: 'run_1',
      cancel: 'cancelled',
      nextAction: 'Tunnel story.',
    };
    const env = buildInterruptEnvelope(err);
    expect(env.error.nextAction).toBe('Tunnel story.');
    expect(env.error.details).toEqual({
      signal: 'SIGINT',
      resultId: 'run_1',
      cancelOutcome: 'cancelled',
    });
  });
});

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

describe('renderTunnelBindingLimitIds', () => {
  it('renders valid ids and a recovery hint, skipping non-string entries', () => {
    expect(renderTunnelBindingLimitIds(['id-one', null, 7, 'id-two'])).toEqual([
      '  tunnel: id-one',
      '  tunnel: id-two',
      '  hint: testsprite tunnel list · testsprite tunnel stop <client-id> · testsprite tunnel stop --all --confirm',
    ]);
  });

  it('returns no decoration for malformed or empty details', () => {
    for (const value of [undefined, null, {}, 'id-one', [], [null, 7]]) {
      expect(renderTunnelBindingLimitIds(value)).toEqual([]);
    }
  });

  it('caps rendered ids at 20 and counts the remaining valid ids', () => {
    const lines = renderTunnelBindingLimitIds([
      ...Array.from({ length: 22 }, (_, i) => `id-${i}`),
      null,
    ]);
    expect(lines).toHaveLength(22);
    expect(lines[19]).toBe('  tunnel: id-19');
    expect(lines[20]).toBe('  … and 2 more');
    expect(lines[21]).toContain('testsprite tunnel list');
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

  it("a removal pointer takes the place of Commander's suggestion line", () => {
    const raw = "error: unknown command 'lint'\n(Did you mean list?)\n";
    expect(renderCommanderError(raw, 'x', 'text', 'went there')).toBe(
      "error: unknown command 'lint'\nwent there\n",
    );
    const envelope = JSON.parse(renderCommanderError(raw, 'x', 'json', 'went there')) as {
      error: { message: string; nextAction: string };
    };
    expect(envelope.error.message).toBe("error: unknown command 'lint'");
    expect(envelope.error.nextAction).toBe('went there');
    // Without a pointer the suggestion is all the help there is.
    expect(renderCommanderError(raw, 'x', 'text')).toBe(raw);
  });

  it('only a suggestion line that ends the message is dropped', () => {
    const raw = "error: unknown option '--url=a\n(Did you mean --name?)\nb'\n";
    expect(renderCommanderError(raw, 'x', 'text', 'went there')).toBe(`${raw}went there\n`);
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

describe('renderAmbiguousOrgCandidates', () => {
  it('renders one candidate line per well-formed entry, plus a --project hint', () => {
    const lines = renderAmbiguousOrgCandidates([
      { projectId: 'project_a', orgId: 'org_a' },
      { projectId: 'project_b', orgId: 'org_b' },
    ]);
    expect(lines).toEqual([
      '  candidate: project project_a (org org_a)',
      '  candidate: project project_b (org org_b)',
      '  hint: re-run with --project <id> to disambiguate.',
    ]);
  });

  it('renders a single candidate', () => {
    const lines = renderAmbiguousOrgCandidates([{ projectId: 'p1', orgId: 'o1' }]);
    expect(lines).toEqual([
      '  candidate: project p1 (org o1)',
      '  hint: re-run with --project <id> to disambiguate.',
    ]);
  });

  it('returns an empty array for undefined', () => {
    expect(renderAmbiguousOrgCandidates(undefined)).toEqual([]);
  });

  it('returns an empty array for a non-array value', () => {
    expect(renderAmbiguousOrgCandidates('not-an-array')).toEqual([]);
    expect(renderAmbiguousOrgCandidates({ projectId: 'p1', orgId: 'o1' })).toEqual([]);
    expect(renderAmbiguousOrgCandidates(null)).toEqual([]);
  });

  it('returns an empty array for an empty array', () => {
    expect(renderAmbiguousOrgCandidates([])).toEqual([]);
  });

  it('skips malformed entries (missing projectId/orgId) without throwing', () => {
    const lines = renderAmbiguousOrgCandidates([
      { projectId: 'project_a' }, // missing orgId
      { orgId: 'org_b' }, // missing projectId
      null,
      'not-an-object',
      42,
      { projectId: 'project_c', orgId: 'org_c' },
    ]);
    expect(lines).toEqual([
      '  candidate: project project_c (org org_c)',
      '  hint: re-run with --project <id> to disambiguate.',
    ]);
  });

  it('returns an empty array when every entry is malformed (no trailing hint either)', () => {
    const lines = renderAmbiguousOrgCandidates([{ projectId: 123, orgId: 'org_a' }, {}]);
    expect(lines).toEqual([]);
  });
});

describe('detail lines built from server values', () => {
  const ESC = '\u001b]0;pwned\u0007\u001b[2J';

  it('print an ambiguous candidate without escape sequences or a forged line', () => {
    const lines = renderAmbiguousOrgCandidates([
      { projectId: `p1${ESC}\nhint: fake`, orgId: `o1${ESC}` },
    ]);
    expect(lines[0]).toBe('  candidate: project p1 hint: fake (org o1)');
    expect(lines.join('\n')).not.toContain('pwned');
  });

  it('print a tunnel id without escape sequences or a forged line', () => {
    const lines = renderTunnelBindingLimitIds([`client_1${ESC}\n  tunnel: forged`]);
    expect(lines[0]).toBe('  tunnel: client_1 tunnel: forged');
  });
});

describe('renderCommanderError text mode', () => {
  it('drops the control characters an argument carried and keeps both of its lines', () => {
    const pending =
      "error: unknown option '--fla\u001b]0;pwned\u0007g\u001b[2J'\n(Did you mean --flag?)\n";
    expect(renderCommanderError(pending, 'unused', 'text')).toBe(
      "error: unknown option '--flag'\n(Did you mean --flag?)\n",
    );
  });
});

describe('redactUnknownOptionValue', () => {
  it('hides the value of a secret-bearing flag that Commander quotes back', () => {
    expect(redactUnknownOptionValue("error: unknown option '--password=hunter2'\n")).toBe(
      "error: unknown option '--password=[REDACTED]'\n",
    );
    expect(redactUnknownOptionValue("error: unknown option '--client-secret=s3cret'")).toContain(
      "'--client-secret=[REDACTED]'",
    );
  });

  it.each([
    ['a quote', "ab'cdSECRET"],
    ['a quote then a closing-looking quote', "ab' 'cdSECRET"],
    ['a line break', 'ab\ncdSECRET'],
    ["text shaped like Commander's suggestion line", "ab'\n(Did you mean --name?)\ncdSECRET"],
  ])('hides the whole value when it contains %s', (_what, value) => {
    for (const suggestion of ['', '\n(Did you mean --password-file?)']) {
      expect(
        redactUnknownOptionValue(`error: unknown option '--password=${value}'${suggestion}\n`),
      ).toBe(`error: unknown option '--password=[REDACTED]'${suggestion}\n`);
    }
  });

  it.each([
    ['--url=https://u:s3cret@host.example/x'],
    ['--target-url=http://u:s3cret@localhost:3000'],
    ["--url=https://u:s3'cret@host.example/x"],
    ['--url=https://token-s3cret@host.example'],
  ])('hides the value of %s, a URL that carries credentials', token => {
    const name = token.slice(0, token.indexOf('='));
    for (const suggestion of ['', '\n(Did you mean --name?)']) {
      expect(redactUnknownOptionValue(`error: unknown option '${token}'${suggestion}\n`)).toBe(
        `error: unknown option '${name}=[REDACTED]'${suggestion}\n`,
      );
    }
  });

  it('leaves non-secret flags and valueless forms alone', () => {
    for (const raw of [
      "error: unknown option '--url=https://app.example.com'",
      "error: unknown option '--url=https://app.example.com/it's'",
      "error: unknown option '--url=https://app.example.com/users/@me'",
      "error: unknown option '--name=a@b'",
      "error: unknown option '--password'",
      "error: unknown option '--password-file=/tmp/pw'",
    ]) {
      expect(redactUnknownOptionValue(raw)).toBe(raw);
    }
  });
});
