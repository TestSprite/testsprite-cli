import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runLint } from './test.js';

describe('runLint assertion-complexity warnings', () => {
  it('warns when a frontend assertion contains conditional or multi-branch wording', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-lint-conditional-'));
    const file = join(dir, 'plan.json');
    writeFileSync(
      file,
      JSON.stringify({
        projectId: 'project_alice',
        type: 'frontend',
        name: 'Knowledge Web renders',
        planSteps: [
          {
            type: 'assertion',
            description: 'Verify either an interactive graph canvas or a clear empty-state message',
          },
        ],
      }),
      'utf8',
    );

    const report = await runLint(
      { profile: 'default', output: 'json', debug: false, planFrom: file },
      { stdout: () => undefined },
    );

    expect(report).toMatchObject({ checked: 1, valid: 1, issues: [] });
    expect(report.warnings).toEqual([
      expect.objectContaining({
        field: 'planSteps[0].description',
        reason: expect.stringContaining('single, decisive assertion'),
      }),
    ]);
  });

  it('keeps text warnings on stderr and stdout machine-safe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-lint-warning-streams-'));
    const file = join(dir, 'plan.json');
    writeFileSync(
      file,
      JSON.stringify({
        projectId: 'project_alice',
        type: 'frontend',
        name: 'Knowledge Web renders',
        planSteps: [
          {
            type: 'assertion',
            description: 'Verify either an interactive graph canvas or a clear empty-state message',
          },
        ],
      }),
      'utf8',
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    await runLint(
      { profile: 'default', output: 'text', debug: false, planFrom: file },
      { stdout: line => stdout.push(line), stderr: line => stderr.push(line) },
    );

    expect(stdout.join('\n')).toBe('1/1 valid, 0 problem(s)');
    expect(stdout.join('\n')).not.toContain('[warning]');
    expect(stderr.join('\n')).toContain('[warning]');
    expect(stderr.at(-1)).toBe('1 warning(s)');
  });

  it('does not flag actions or single-outcome assertions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-lint-decisive-'));
    const file = join(dir, 'plan.json');
    writeFileSync(
      file,
      JSON.stringify({
        projectId: 'project_alice',
        type: 'frontend',
        name: 'Checkout works',
        planSteps: [
          { type: 'action', description: 'Open the cart or return to the catalog' },
          { type: 'assertion', description: 'Verify the order total is visible' },
        ],
      }),
      'utf8',
    );

    const report = await runLint(
      { profile: 'default', output: 'json', debug: false, planFrom: file },
      { stdout: () => undefined },
    );

    expect(report).toEqual({ checked: 1, valid: 1, issues: [] });
  });
});
