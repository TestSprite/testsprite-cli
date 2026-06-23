import { describe, expect, it } from 'vitest';

/**
 * The version guard logic extracted for testability.
 * The real guard lives at the top of src/index.ts as imperative code.
 * These tests verify the parsing and threshold logic.
 */

function parseMajorVersion(nodeVersion: string): number {
  return Number(nodeVersion.split('.')[0]);
}

function shouldRejectVersion(nodeVersion: string): boolean {
  return parseMajorVersion(nodeVersion) < 20;
}

describe('Node.js version guard logic', () => {
  it('rejects Node 18.x', () => {
    expect(shouldRejectVersion('18.19.1')).toBe(true);
  });

  it('rejects Node 16.x', () => {
    expect(shouldRejectVersion('16.20.2')).toBe(true);
  });

  it('rejects Node 14.x', () => {
    expect(shouldRejectVersion('14.21.3')).toBe(true);
  });

  it('accepts Node 20.x', () => {
    expect(shouldRejectVersion('20.11.0')).toBe(false);
  });

  it('accepts Node 22.x', () => {
    expect(shouldRejectVersion('22.1.0')).toBe(false);
  });

  it('accepts Node 21.x', () => {
    expect(shouldRejectVersion('21.0.0')).toBe(false);
  });

  it('parses major version correctly from semver string', () => {
    expect(parseMajorVersion('20.11.1')).toBe(20);
    expect(parseMajorVersion('18.0.0')).toBe(18);
    expect(parseMajorVersion('22.3.0')).toBe(22);
  });

  it('the running Node satisfies the guard (meta-test)', () => {
    // This test is running on Node >= 20, so it must pass the guard.
    expect(shouldRejectVersion(process.versions.node)).toBe(false);
  });
});
