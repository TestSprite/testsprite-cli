import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { readCredentialsFile } from '../src/lib/credentials.js';
import { execNpm } from './helpers/execNpm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CHILD_PATH = join(REPO_ROOT, 'test', 'helpers', 'credentials-write-child.mjs');

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

function runCredentialWriter(env: Record<string, string>): Promise<ChildResult> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [CHILD_PATH], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
    }, 10_000);

    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveChild({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

describe('credentials cross-process writes', () => {
  beforeAll(() => {
    execNpm(['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });
  });

  it('preserves every profile written by concurrent child processes', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'testsprite-creds-race-'));
    const credentialsPath = join(tmpRoot, 'credentials');
    const startPath = join(tmpRoot, 'start');

    try {
      const profiles = Array.from({ length: 8 }, (_, index) => ({
        apiKey: `sk-child-${index}`,
        profile: `child-${index}`,
      }));
      const children = profiles.map(({ apiKey, profile }) =>
        runCredentialWriter({
          CRED_API_KEY: apiKey,
          CRED_PATH: credentialsPath,
          CRED_PROFILE: profile,
          CRED_START_PATH: startPath,
        }),
      );

      await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
      writeFileSync(startPath, 'go');

      const results = await Promise.all(children);
      expect(results).toEqual(
        profiles.map(() => ({
          code: 0,
          signal: null,
          stderr: '',
          stdout: '',
        })),
      );

      const credentials = readCredentialsFile({ path: credentialsPath });
      for (const { apiKey, profile } of profiles) {
        expect(credentials[profile]).toEqual({ apiKey });
      }
      expect(existsSync(`${credentialsPath}.lock`)).toBe(false);
    } finally {
      rmSync(tmpRoot, { force: true, recursive: true });
    }
  }, 20_000);
});
