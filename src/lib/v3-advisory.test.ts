import { describe, expect, it } from 'vitest';
import {
  routingLabel,
  V3_ROUTING_ADVISORY,
  emitV3RoutingAdvisory,
  targetUrlAdvisoryText,
  emitTargetUrlMismatchAdvisory,
} from './v3-advisory.js';

describe('routingLabel', () => {
  it('maps the boolean to v3 / v2', () => {
    expect(routingLabel(true)).toBe('v3');
    expect(routingLabel(false)).toBe('v2');
  });
});

describe('V3 routing advisory', () => {
  it('names the open behavior gaps', () => {
    const text = V3_ROUTING_ADVISORY.join('\n');
    expect(text).toContain('--target-url');
    expect(text).toContain('rerun');
  });

  // Warning about behavior that now works trains users to ignore the block.
  it('no longer warns about gaps that have shipped', () => {
    const text = V3_ROUTING_ADVISORY.join('\n');
    expect(text).not.toContain('test cancel');
    expect(text).not.toContain('zombie');
  });

  it('emitV3RoutingAdvisory writes every line to the sink', () => {
    const lines: string[] = [];
    emitV3RoutingAdvisory(l => lines.push(l));
    expect(lines).toEqual(V3_ROUTING_ADVISORY);
  });
});

describe('target-url mismatch advisory (response-driven redesign)', () => {
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
