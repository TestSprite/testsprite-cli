import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { createTestCommand, parseExpectedStepCountFlag } from './test.js';

function disableExits(cmd: Command): void {
  cmd.exitOverride();
  cmd.commands.forEach(disableExits);
}

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-expected-step-count-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = http://localhost:13503\napi_key = sk-user-test\n',
    { mode: 0o600 },
  );
  return { credentialsPath };
}

function stepsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-expected-step-count-steps-'));
  const path = join(dir, 'steps.json');
  writeFileSync(
    path,
    JSON.stringify({
      planSteps: [{ type: 'action', description: 'open /login' }],
    }),
  );
  return path;
}

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

describe('createTestCommand plan put --expected-step-count', () => {
  it.each(['', '  '])(
    'rejects blank raw value "%s" before fetch (exit 5)',
    async raw => {
      const { credentialsPath } = makeCreds();
      const steps = stepsFile();
      const fetchImpl = vi.fn<typeof globalThis.fetch>();
      const cmd = createTestCommand({
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: () => undefined,
      });
      cmd.option('--output <mode>', 'output mode');
      disableExits(cmd);

      await expect(
        cmd.parseAsync(
          [
            'plan',
            'put',
            'test_1',
            '--steps',
            steps,
            '--expected-step-count',
            raw,
            '--output',
            'json',
          ],
          { from: 'user' },
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        exitCode: 5,
        details: expect.objectContaining({ field: 'expected-step-count' }),
      });

      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
