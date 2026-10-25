/**
 * Fixture-password sweep across every credential-taking command: drives each
 * one with a distinctive fixture password, in every output mode and with
 * `--debug` on (debug lines route through the same `stderr` sink), and
 * asserts the fixture value appears in NONE of stdout / stderr — real
 * network path and `--dry-run` alike.
 *
 * This is a cross-cutting proof, not a replacement for the focused specs
 * next to each command (`project.test.ts`, `project-env.spec.ts`), which
 * cover the individual behaviors (mutual exclusion, dry-run ordering) with
 * mutation-proven red/green cycles.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCreate, runUpdate, type ProjectDeps } from './project.js';
import { runEnvCreate, runEnvUpdate } from './project-env.js';

const FIXTURE_PASSWORD = 'hunter2-FIXTURE-SWEEP-DO-NOT-PRINT';

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-secret-sweep-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture: `dir` comes from this function's own mkdtempSync() call.
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture: `credentialsPath` is inside that mkdtempSync() directory.
  writeFileSync(
    credentialsPath,
    `[default]\napi_url = http://localhost:13599\napi_key = sk-user-test\n`,
    { mode: 0o600 },
  );
  return { credentialsPath };
}

function capture(): {
  deps: Pick<ProjectDeps, 'stdout' | 'stderr'>;
  all: () => string;
} {
  const lines: string[] = [];
  return {
    deps: {
      stdout: (l: string) => lines.push(l),
      stderr: (l: string) => lines.push(l),
    },
    all: () => lines.join('\n'),
  };
}

function fetchReturning(body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

const ENV_RESPONSE = {
  environment: {
    id: '10cde22f-f017-415c-b7e5-f236cb564e28',
    name: 'demo',
    url: 'https://demo.example.com',
    isDefault: false,
    authMode: 'account',
    hasCredentials: true,
    username: 'qa@example.com',
    enableOtp: false,
    updatedAt: '2026-09-09T00:00:00.000Z',
  },
};

const PROJECT_CREATE_RESPONSE = {
  projectId: 'p_1',
  id: 'p_1',
  name: 'Secret Sweep Project',
  type: 'frontend' as const,
  createdFrom: 'cli' as const,
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z',
  targetUrl: 'https://example.com',
};

const PROJECT_UPDATE_RESPONSE = {
  projectId: 'p_1',
  id: 'p_1',
  updatedFields: ['password'],
  updatedAt: '2026-09-09T00:00:00.000Z',
};

describe('fixture-password sweep — never appears in stdout, stderr, or --debug output', () => {
  const outputs = ['text', 'json'] as const;
  const dryRuns = [false, true] as const;

  it.each(outputs.flatMap(output => dryRuns.map(dryRun => [output, dryRun] as const)))(
    'project env create --output %s --dry-run=%s',
    async (output, dryRun) => {
      const { credentialsPath } = makeCreds();
      const { deps, all } = capture();
      await runEnvCreate(
        {
          profile: 'default',
          output,
          debug: true,
          dryRun,
          projectId: 'proj_1',
          name: 'sweep',
          url: 'https://sweep.example.com',
          username: 'qa@example.com',
          password: FIXTURE_PASSWORD,
        },
        { credentialsPath, fetchImpl: fetchReturning(ENV_RESPONSE), ...deps },
      );
      expect(all()).not.toContain(FIXTURE_PASSWORD);
    },
  );

  it.each(outputs.flatMap(output => dryRuns.map(dryRun => [output, dryRun] as const)))(
    'project env update --output %s --dry-run=%s',
    async (output, dryRun) => {
      const { credentialsPath } = makeCreds();
      const { deps, all } = capture();
      await runEnvUpdate(
        {
          profile: 'default',
          output,
          debug: true,
          dryRun,
          projectId: 'proj_1',
          name: 'sweep',
          password: FIXTURE_PASSWORD,
        },
        { credentialsPath, fetchImpl: fetchReturning(ENV_RESPONSE), ...deps },
      );
      expect(all()).not.toContain(FIXTURE_PASSWORD);
    },
  );

  it.each(outputs.flatMap(output => dryRuns.map(dryRun => [output, dryRun] as const)))(
    'project create --output %s --dry-run=%s',
    async (output, dryRun) => {
      const { credentialsPath } = makeCreds();
      const { deps, all } = capture();
      await runCreate(
        {
          profile: 'default',
          output,
          debug: true,
          dryRun,
          type: 'frontend',
          name: 'Secret Sweep Project',
          targetUrl: 'https://example.com',
          username: 'qa@example.com',
          password: FIXTURE_PASSWORD,
        },
        { credentialsPath, fetchImpl: fetchReturning(PROJECT_CREATE_RESPONSE), ...deps },
      );
      expect(all()).not.toContain(FIXTURE_PASSWORD);
    },
  );

  it.each(outputs.flatMap(output => dryRuns.map(dryRun => [output, dryRun] as const)))(
    'project update --output %s --dry-run=%s',
    async (output, dryRun) => {
      const { credentialsPath } = makeCreds();
      const { deps, all } = capture();
      await runUpdate(
        {
          profile: 'default',
          output,
          debug: true,
          dryRun,
          projectId: 'p_1',
          password: FIXTURE_PASSWORD,
        },
        { credentialsPath, fetchImpl: fetchReturning(PROJECT_UPDATE_RESPONSE), ...deps },
      );
      expect(all()).not.toContain(FIXTURE_PASSWORD);
    },
  );

  // NOTE on scope: these four commands never print or catch a thrown
  // ApiError themselves — a server error just rejects the returned promise
  // for the CLI's top-level handler (`index.ts`) to render. So a server
  // that echoed the password back in an error envelope's `details` would
  // not appear in THIS sweep's stdout/stderr capture regardless of
  // redaction, and a test claiming to cover that here would be vacuous.
  // That end-to-end scenario (server echo -> `index.ts`'s JSON envelope)
  // is covered instead by `index.spec.ts`'s "error envelope redacts nested
  // secrets" and `errors.test.ts`'s ApiError-construction-time redaction
  // test, both proven red/green against a real mutation.
});
