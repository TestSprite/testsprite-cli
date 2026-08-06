import { describe, expect, it } from 'vitest';
import { routingLabel, V3_ROUTING_ADVISORY, emitV3RoutingAdvisory } from './v3-advisory.js';

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
