import { createRequire } from 'node:module';
import { writeSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  MIN_SUPPORTED_NODE_MAJOR,
  SUPPORTED_NODE_ENGINE,
  SUPPORTED_NODE_RANGE,
  parseMajorVersion,
  rejectUnsupportedNodeVersion,
  shouldRejectNodeVersion,
} from './version-guard.js';

vi.mock('node:fs', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, writeSync: vi.fn() };
});

const require = createRequire(import.meta.url);
const pkg: { engines: { node: string } } = require('../package.json') as {
  engines: { node: string };
};

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
  it('stays pinned to package.json engines.node', () => {
    expect(SUPPORTED_NODE_ENGINE).toBe(pkg.engines.node);
  });

  it('rejects runtimes outside the declared engines range', () => {
    expect(shouldRejectNodeVersion('18.19.1')).toBe(true);
    expect(shouldRejectNodeVersion('20.0.0')).toBe(true);
    expect(shouldRejectNodeVersion('20.18.99')).toBe(true);
    expect(shouldRejectNodeVersion('21.99.0')).toBe(true);
    expect(shouldRejectNodeVersion('22.0.0')).toBe(true);
    expect(shouldRejectNodeVersion('22.12.99')).toBe(true);
    expect(shouldRejectNodeVersion('23.99.99')).toBe(true);
  });

  it('accepts every supported Node window', () => {
    expect(shouldRejectNodeVersion('20.19.0')).toBe(false);
    expect(shouldRejectNodeVersion('20.99.0')).toBe(false);
    expect(shouldRejectNodeVersion('22.13.0')).toBe(false);
    expect(shouldRejectNodeVersion('22.99.0')).toBe(false);
    expect(shouldRejectNodeVersion('24.0.0')).toBe(false);
    expect(shouldRejectNodeVersion('25.0.0')).toBe(false);
  });

  it(`keeps the major floor constant at ${MIN_SUPPORTED_NODE_MAJOR}`, () => {
    expect(shouldRejectNodeVersion(`${MIN_SUPPORTED_NODE_MAJOR}.19.0`)).toBe(false);
    expect(shouldRejectNodeVersion(`${MIN_SUPPORTED_NODE_MAJOR - 1}.99.99`)).toBe(true);
  });

  it('does not reject an unparseable version (guard never blocks on garbage)', () => {
    expect(shouldRejectNodeVersion('not-a-version')).toBe(false);
  });

  it('the running Node satisfies the guard (meta-test)', () => {
    // The test suite itself runs on a supported Node, so the guard must pass.
    expect(shouldRejectNodeVersion(process.versions.node)).toBe(false);
  });
});

describe('rejectUnsupportedNodeVersion', () => {
  it('does nothing on a supported runtime', () => {
    const writeStderr = vi.fn();
    const exit = vi.fn();
    rejectUnsupportedNodeVersion('22.13.0', { writeStderr, exit });

    expect(writeStderr).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('writes the unchanged error before exiting for an unsupported runtime', () => {
    const events: string[] = [];
    const writeStderr = vi.fn((message: string) => events.push(message));
    const exit = vi.fn((code: number) => events.push(`exit ${code}`));
    rejectUnsupportedNodeVersion('18.19.1', { writeStderr, exit });

    const message = `Error: testsprite requires Node.js ${SUPPORTED_NODE_RANGE} (found 18.19.1).\nInstall a supported Node.js release from https://nodejs.org\n`;
    expect(events).toEqual([message, 'exit 1']);
  });

  it('uses a synchronous stderr write by default', () => {
    vi.mocked(writeSync).mockClear();
    const exit = vi.fn();
    rejectUnsupportedNodeVersion('20.18.0', { exit });

    expect(writeSync).toHaveBeenCalledWith(
      process.stderr.fd,
      `Error: testsprite requires Node.js ${SUPPORTED_NODE_RANGE} (found 20.18.0).\nInstall a supported Node.js release from https://nodejs.org\n`,
    );
    expect(exit).toHaveBeenCalledWith(1);
  });
});
