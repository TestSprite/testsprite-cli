import { describe, expect, it } from 'vitest';
import { parseExpectedStepCountFlag } from './test.js';

describe('parseExpectedStepCountFlag', () => {
  it('returns undefined when the flag is omitted', () => {
    expect(parseExpectedStepCountFlag(undefined)).toBeUndefined();
  });

  it('rejects empty and whitespace-only raw values before Number coercion', () => {
    for (const raw of ['', ' ', '  ', '\t', '\n']) {
      expect(() => parseExpectedStepCountFlag(raw)).toThrow(
        expect.objectContaining({
          code: 'VALIDATION_ERROR',
          details: expect.objectContaining({ field: 'expected-step-count' }),
        }),
      );
    }
  });

  it('keeps explicit 0 and positive integers', () => {
    expect(parseExpectedStepCountFlag('0')).toBe(0);
    expect(parseExpectedStepCountFlag('2')).toBe(2);
    expect(parseExpectedStepCountFlag('4')).toBe(4);
  });

  it('still rejects non-finite values at the numeric stage', () => {
    expect(() => parseExpectedStepCountFlag('nope')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});
