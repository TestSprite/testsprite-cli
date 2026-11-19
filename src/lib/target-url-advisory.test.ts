import { describe, expect, it } from 'vitest';
import { targetUrlAdvisoryText, emitTargetUrlMismatchAdvisory } from './target-url-advisory.js';

describe('target-url mismatch advisory (response-driven)', () => {
  it('is a single [advisory]-prefixed line naming --target-url and the requested value', () => {
    const text = targetUrlAdvisoryText('https://staging.example.com', '');
    expect(text.startsWith('[advisory]')).toBe(true);
    expect(text).toContain('--target-url https://staging.example.com');
    // Type-agnostic: never claims this is V3-specific, since the comparison
    // is purely response-driven and applies identically whatever the cause.
    expect(text).not.toContain('V3');
    expect(text).not.toContain('frontend');
  });

  it('names the value the server actually applied when it applied a (different) one', () => {
    const text = targetUrlAdvisoryText('https://staging.example.com', 'https://prod.example.com');
    expect(text).toContain('https://prod.example.com instead');
  });

  it('says no target URL was applied when the response is empty', () => {
    const text = targetUrlAdvisoryText('https://staging.example.com', '');
    expect(text).toContain('reports no target URL for it');
  });

  it('emitTargetUrlMismatchAdvisory writes exactly one line when requested != applied', () => {
    const lines: string[] = [];
    emitTargetUrlMismatchAdvisory(l => lines.push(l), 'https://staging.example.com', '');
    expect(lines).toEqual([targetUrlAdvisoryText('https://staging.example.com', '')]);
  });

  it('emitTargetUrlMismatchAdvisory is a no-op when requested === applied (override was honored)', () => {
    const lines: string[] = [];
    emitTargetUrlMismatchAdvisory(
      l => lines.push(l),
      'https://staging.example.com',
      'https://staging.example.com',
    );
    expect(lines).toEqual([]);
  });
});
