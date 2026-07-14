import { describe, expect, it } from 'vitest';
import {
  MIN_SUPPORTED_NODE_MAJOR,
  parseMajorVersion,
  shouldRejectNodeVersion,
} from './version-guard.js';

// These tests exercise the REAL guard functions used by src/index.ts,
// imported here rather than re-declared, so a regression in the source is
// actually caught.

describe('parseMajorVersion', () => {
  it('extracts the leading major from a semver string', () => {
    expect(parseMajorVersion('20.11.1')).toBe(20);
    expect(parseMajorVersion('18.0.0')).toBe(18);
    expect(parseMajorVersion('22.3.0')).toBe(22);
  });

  it('returns NaN for a non-numeric version string', () => {
    expect(Number.isNaN(parseMajorVersion('not-a-version'))).toBe(true);
  });
});

describe('shouldRejectNodeVersion', () => {
  it('rejects majors below the supported floor', () => {
    expect(shouldRejectNodeVersion('18.19.1')).toBe(true);
    expect(shouldRejectNodeVersion('16.20.2')).toBe(true);
    expect(shouldRejectNodeVersion('14.21.3')).toBe(true);
  });

  it('accepts the supported floor and above', () => {
    expect(shouldRejectNodeVersion('20.0.0')).toBe(false);
    expect(shouldRejectNodeVersion('20.11.0')).toBe(false);
    expect(shouldRejectNodeVersion('21.0.0')).toBe(false);
    expect(shouldRejectNodeVersion('22.1.0')).toBe(false);
  });

  it(`treats exactly ${MIN_SUPPORTED_NODE_MAJOR} as supported (boundary)`, () => {
    expect(shouldRejectNodeVersion(`${MIN_SUPPORTED_NODE_MAJOR}.0.0`)).toBe(false);
    expect(shouldRejectNodeVersion(`${MIN_SUPPORTED_NODE_MAJOR - 1}.9.9`)).toBe(true);
  });

  it('does not reject an unparseable version (guard never blocks on garbage)', () => {
    expect(shouldRejectNodeVersion('not-a-version')).toBe(false);
  });

  it('the running Node satisfies the guard (meta-test)', () => {
    // The test suite itself runs on a supported Node, so the guard must pass.
    expect(shouldRejectNodeVersion(process.versions.node)).toBe(false);
  });
});
