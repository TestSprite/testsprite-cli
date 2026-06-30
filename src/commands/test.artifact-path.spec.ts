/**
 * Regression coverage for default artifact output path containment.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDefaultArtifactDir, runArtifactGet } from './test.js';

describe('resolveDefaultArtifactDir', () => {
  it('keeps a normal run id under .testsprite/runs', () => {
    const cwd = join(tmpdir(), 'artifact-path');
    expect(resolveDefaultArtifactDir('run_abc123', cwd)).toBe(
      join(cwd, '.testsprite', 'runs', 'run_abc123'),
    );
  });

  it.each(['.', '..', '../outside', '..\\outside', 'nested/run', 'nested\\run', 'bad\0id'])(
    'rejects path-like run id %j',
    runId => {
      expect(() => resolveDefaultArtifactDir(runId, '/tmp/work')).toThrowError(
        expect.objectContaining({
          code: 'VALIDATION_ERROR',
          details: expect.objectContaining({ field: 'run-id' }),
        }),
      );
    },
  );
});

describe('runArtifactGet default output path validation', () => {
  it('rejects unsafe default run ids before auth or fetch work', async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls++;
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

    await expect(
      runArtifactGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          runId: '../../outside',
          failedOnly: false,
        },
        { fetchImpl, stdout: () => {} },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'run-id' }),
    });
    expect(fetchCalls).toBe(0);
  });
});
