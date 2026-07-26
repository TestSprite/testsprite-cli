/**
 * Unit tests for `testsprite usage` / `testsprite credits`.
 *
 * Backend follow-up: the `/me` endpoint must add `credits` + `subPlan` projection.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeProfile } from '../lib/credentials.js';
import type { UsageDeps, UsageResponse } from './usage.js';
import { DRY_RUN_USAGE_SAMPLE, createUsageCommand, runUsage } from './usage.js';

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

function makeCapture(): {
  capture: CapturedOutput;
  deps: Pick<UsageDeps, 'stdout' | 'stderr'>;
} {
  const capture: CapturedOutput = { stdout: [], stderr: [] };
  return {
    capture,
    deps: {
      stdout: line => capture.stdout.push(line),
      stderr: line => capture.stderr.push(line),
    },
  };
}

/** Minimal MeResponse without credits/subPlan (backend current state) */
const meWithoutCredits = {
  userId: 'u-abc',
  keyId: 'k-abc',
  scopes: ['read:projects', 'read:tests', 'write:tests', 'run:tests'],
  env: 'development' as const,
};

/** Extended MeResponse WITH credits + subPlan (backend future state) */
const meWithCredits: UsageResponse = {
  ...meWithoutCredits,
  credits: 100,
  subPlan: 'Standard',
  creditsPerRun: 2,
};

function makeFetch(body: unknown, status = 200): UsageDeps['fetchImpl'] {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as UsageDeps['fetchImpl'];
}

let credentialsPath: string;

beforeEach(() => {
  credentialsPath = join(mkdtempSync(join(tmpdir(), 'testsprite-usage-')), 'credentials');
});

describe('runUsage — dry-run', () => {
  it('emits the dry-run banner + note about missing backend data', async () => {
    const { capture, deps } = makeCapture();
    const result = await runUsage(
      { profile: 'default', output: 'text', debug: false, dryRun: true },
      deps,
    );
    const stderr = capture.stderr.join('\n');
    // Banner must be present.
    expect(stderr).toContain('dry-run');
    // Must note that credits require a backend update.
    expect(stderr).toContain('backend');
    // Must return the canned sample.
    expect(result).toEqual(DRY_RUN_USAGE_SAMPLE);
  });

  it('dry-run sample contains credits, subPlan, and creditsPerRun', () => {
    expect(DRY_RUN_USAGE_SAMPLE.credits).toBeGreaterThan(0);
    expect(DRY_RUN_USAGE_SAMPLE.subPlan).toBeTruthy();
    expect(DRY_RUN_USAGE_SAMPLE.creditsPerRun).toBeGreaterThan(0);
  });

  it('dry-run JSON output contains the sample fields', async () => {
    const { capture, deps } = makeCapture();
    await runUsage({ profile: 'default', output: 'json', debug: false, dryRun: true }, deps);
    const parsed = JSON.parse(capture.stdout.join('')) as UsageResponse;
    expect(parsed.credits).toBe(DRY_RUN_USAGE_SAMPLE.credits);
    expect(parsed.subPlan).toBe(DRY_RUN_USAGE_SAMPLE.subPlan);
    expect(parsed.creditsPerRun).toBe(DRY_RUN_USAGE_SAMPLE.creditsPerRun);
  });
});

describe('runUsage — real path without credits (current backend)', () => {
  it('returns the /me response and emits a note about missing balance', async () => {
    writeProfile('default', { apiKey: 'sk-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const result = await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(meWithoutCredits),
      },
    );
    expect(result.userId).toBe('u-abc');
    expect(result.credits).toBeUndefined();
    // Must emit the note pointing at the billing URL.
    const stderr = capture.stderr.join('\n');
    expect(stderr).toContain('billing');
    expect(stderr).toContain('testsprite.com');
  });

  // Issue #277: the usage projection is validated at the client boundary, so a
  // string balance surfaces as a typed envelope instead of silently reaching
  // the `Math.floor(credits / creditsPerRun)` pre-flight arithmetic.
  it('rejects a non-numeric credit balance with a typed INTERNAL envelope', async () => {
    writeProfile('default', { apiKey: 'sk-abc' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const rejection = await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch({ ...meWithoutCredits, credits: '100', creditsPerRun: 2 }),
      },
    ).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: 'INTERNAL' });
  });

  it('text output includes identity fields even without credits', async () => {
    writeProfile('default', { apiKey: 'sk-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(meWithoutCredits),
      },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('userId:');
    expect(out).toContain('u-abc');
  });

  it('JSON output passes the raw /me response through (no credits key present)', async () => {
    writeProfile('default', { apiKey: 'sk-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'json', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(meWithoutCredits),
      },
    );
    const parsed = JSON.parse(capture.stdout.join('')) as UsageResponse;
    expect(parsed.userId).toBe('u-abc');
    expect(parsed.credits).toBeUndefined();
  });
});

describe('runUsage — real path with credits (future backend)', () => {
  it('renders balance block when credits + subPlan are present', async () => {
    writeProfile('default', { apiKey: 'sk-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(meWithCredits),
      },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('credits:');
    expect(out).toContain('100');
    expect(out).toContain('plan:');
    expect(out).toContain('Standard');
    expect(out).toContain('cost per frontend run:');
    // Should show max runs estimate.
    expect(out).toContain('can trigger:');
    // 100 / 2 = 50 runs
    expect(out).toContain('50');
  });

  it('does NOT emit the missing-balance note when credits are present', async () => {
    writeProfile('default', { apiKey: 'sk-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(meWithCredits),
      },
    );
    const stderr = capture.stderr.join('\n');
    // No missing-balance note when data is present.
    expect(stderr).not.toContain('not available');
  });

  it('emits low-balance warning when credits < creditsPerRun', async () => {
    writeProfile('default', { apiKey: 'sk-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const lowBalance: UsageResponse = { ...meWithCredits, credits: 1, creditsPerRun: 2 };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(lowBalance),
      },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('warning');
    expect(out).toContain('billing');
  });

  it('emits free-plan upgrade hint when subPlan is Free', async () => {
    writeProfile('default', { apiKey: 'sk-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const freePlan: UsageResponse = { ...meWithCredits, subPlan: 'Free', credits: 10 };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(freePlan),
      },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('Free plan');
    expect(out).toContain('pricing');
  });

  it('JSON output passes credits and subPlan through verbatim', async () => {
    writeProfile('default', { apiKey: 'sk-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'json', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(meWithCredits),
      },
    );
    const parsed = JSON.parse(capture.stdout.join('')) as UsageResponse;
    expect(parsed.credits).toBe(100);
    expect(parsed.subPlan).toBe('Standard');
    expect(parsed.creditsPerRun).toBe(2);
  });
});

describe('runUsage — error handling', () => {
  it('throws AUTH_REQUIRED when no profile is configured', async () => {
    const { deps } = makeCapture();
    await expect(
      runUsage({ profile: 'default', output: 'text', debug: false }, { ...deps, credentialsPath }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('forwards server AUTH_INVALID with exit code 3', async () => {
    writeProfile('default', { apiKey: 'sk-bad' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const errorBody = {
      error: {
        code: 'AUTH_INVALID',
        message: 'Bad key.',
        nextAction: 'rotate it',
        requestId: 'req_x',
        details: {},
      },
    };
    await expect(
      runUsage(
        { profile: 'default', output: 'text', debug: false },
        {
          ...deps,
          credentialsPath,
          fetchImpl: makeFetch(errorBody, 401),
        },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID', exitCode: 3 });
  });

  it('re-maps INSUFFICIENT_CREDITS (rate_limited with credits sub-case) to exit 12', async () => {
    writeProfile('default', { apiKey: 'sk-abc' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const creditError = {
      error: {
        code: 'RATE_LIMITED',
        message: 'Insufficient credits: 2 credit(s) required.',
        nextAction: 'Top up at billing.',
        requestId: 'req_y',
        details: { required: 2, userId: 'u-abc' },
      },
    };
    await expect(
      runUsage(
        { profile: 'default', output: 'text', debug: false },
        {
          ...deps,
          credentialsPath,
          fetchImpl: makeFetch(creditError, 429),
        },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS', exitCode: 12 });
  });
});

describe('createUsageCommand wiring', () => {
  it('exposes the expected command name and credits alias', () => {
    const cmd = createUsageCommand();
    expect(cmd.name()).toBe('usage');
    expect(cmd.alias()).toBe('credits');
  });

  it('--help includes the expected command description', () => {
    const cmd = createUsageCommand();
    const helpText = cmd.helpInformation();
    // Commander's helpInformation() includes the command description.
    expect(helpText).toContain('credit balance');
  });
});
