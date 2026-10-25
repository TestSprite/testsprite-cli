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
  renderAmbiguousOrgCandidates,
  renderTunnelBindingLimitIds,
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
    expect(env.error.nextAction).toContain('testsprite test wait <runId>');
    expect(env.error.requestId).toBe('local');
    expect(env.error.details).toEqual({ signal: 'SIGINT' });
  });

  it('interrupted non-wait request: the generic check-state hint, no run story', () => {
    const env = buildInterruptEnvelope(new InterruptError('SIGINT'));
    expect(env.error.nextAction).toBe(
      'The request was interrupted. Check the current state before retrying; ' +
        'a multi-item command may have processed some items.',
    );
    expect(env.error.nextAction).not.toContain('test wait');
    expect(env.error.details).toEqual({ signal: 'SIGINT' });
  });

  it('plan detach attached: the envelope tells the paused-stage story, never "keeps executing"', () => {
    const err = new InterruptError('SIGINT');
    (err as InterruptError & { planDetach?: unknown }).planDetach = {
      projectId: 'p1',
      stagesRemaining: ['strategy', 'proposals'],
      nextAction:
        'Plan generation paused during stage 1/3 exploration. 2 stages left. ' +
        'Continue: testsprite test plan generate --project p1',
    };
    const env = buildInterruptEnvelope(err);
    expect(env.error.nextAction).toBe(
      'Plan generation paused during stage 1/3 exploration. 2 stages left. ' +
        'Continue: testsprite test plan generate --project p1',
    );
    expect(env.error.nextAction).not.toContain('keeps executing');
    expect(env.error.nextAction).not.toContain('test wait');
    expect(env.error.details).toEqual({
      signal: 'SIGINT',
      projectId: 'p1',
      stagesRemaining: ['strategy', 'proposals'],
    });
  });

  it('plan detach with an unknown plan carries stagesRemaining: null', () => {
    const err = new InterruptError('SIGTERM');
    (err as InterruptError & { planDetach?: unknown }).planDetach = {
      projectId: 'p1',
      stagesRemaining: null,
      nextAction: 'Plan generation paused. Continue: testsprite test plan generate --project p1',
    };
    const env = buildInterruptEnvelope(err);
    expect(env.error.details).toEqual({
      signal: 'SIGTERM',
      projectId: 'p1',
      stagesRemaining: null,
    });
  });

  it('tunnel detach attached: its nextAction and run details win, unchanged', () => {
    const err = new InterruptError('SIGINT');
    (err as InterruptError & { tunnelDetach?: unknown }).tunnelDetach = {
      runId: 'run_1',
      cancel: 'cancelled',
      nextAction: 'Tunnel story.',
    };
    const env = buildInterruptEnvelope(err);
    expect(env.error.nextAction).toBe('Tunnel story.');
    expect(env.error.details).toEqual({
      signal: 'SIGINT',
      runId: 'run_1',
      cancelOutcome: 'cancelled',
    });
  });

  it('precedence: a tunnel detach beats a plan detach, which beats a run wait', () => {
    const plan = {
      projectId: 'p1',
      stagesRemaining: ['proposals'],
      nextAction: 'Plan story.',
    };
    const tunnel = { runId: 'run_1', cancel: 'cancelled', nextAction: 'Tunnel story.' };
    const withMarkers = (markers: { tunnel?: boolean; plan?: boolean }) => {
      const err = new InterruptError('SIGINT');
      err.runWaitContext = true;
      const tagged = err as InterruptError & { tunnelDetach?: unknown; planDetach?: unknown };
      if (markers.tunnel) tagged.tunnelDetach = tunnel;
      if (markers.plan) tagged.planDetach = plan;
      return buildInterruptEnvelope(err);
    };

    const all = withMarkers({ tunnel: true, plan: true });
    expect(all.error.nextAction).toBe('Tunnel story.');
    expect(all.error.details).toEqual({
      signal: 'SIGINT',
      runId: 'run_1',
      cancelOutcome: 'cancelled',
    });

    const planAndRun = withMarkers({ plan: true });
    expect(planAndRun.error.nextAction).toBe('Plan story.');
    expect(planAndRun.error.details).toEqual({
      signal: 'SIGINT',
      projectId: 'p1',
      stagesRemaining: ['proposals'],
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
