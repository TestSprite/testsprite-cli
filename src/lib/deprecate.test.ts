import { describe, expect, it } from 'vitest';
import {
  REMOVED_IN,
  TEST_FLAKY_DEPRECATION,
  TEST_RERUN_DEPRECATION,
  deprecationNoticeLine,
  emitDeprecationEntry,
  emitDeprecationNotice,
} from './deprecate.js';

describe('deprecation entries', () => {
  it('names the replacement and the earliest removal release', () => {
    const line = deprecationNoticeLine(TEST_RERUN_DEPRECATION);
    expect(line.startsWith('[deprecated]')).toBe(true);
    expect(line).toContain('`testsprite test rerun`');
    expect(line).toContain('`testsprite test run`');
    expect(line).toContain(`removed in ${REMOVED_IN}`);
    expect(REMOVED_IN).toBe('0.17.0');
  });

  it('keeps the replacement a template', () => {
    expect(TEST_RERUN_DEPRECATION.replacement).toBe('test run');
    expect(TEST_FLAKY_DEPRECATION.replacement).toBe('test run');
  });

  it('defaults the advice to the replacement and lets a caller override it', () => {
    expect(deprecationNoticeLine(TEST_RERUN_DEPRECATION)).toBe(
      '[deprecated] `testsprite test rerun` is deprecated and will be removed in 0.17.0. Use `testsprite test run`.',
    );
    expect(deprecationNoticeLine(TEST_RERUN_DEPRECATION, 'Use X.')).toBe(
      '[deprecated] `testsprite test rerun` is deprecated and will be removed in 0.17.0. Use X.',
    );
  });

  it('emits exactly one stderr line per entry', () => {
    const lines: string[] = [];
    emitDeprecationEntry(TEST_FLAKY_DEPRECATION, l => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('test flaky');
  });

  it('leaves the alias notice text unchanged', () => {
    const lines: string[] = [];
    emitDeprecationNotice('init', 'setup', l => lines.push(l));
    expect(lines).toEqual([
      '[deprecated] `testsprite init` is deprecated — use `testsprite setup`.',
    ]);
  });
});
