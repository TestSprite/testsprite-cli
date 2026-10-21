/* eslint-disable security/detect-non-literal-fs-filename -- Every filesystem path belongs to the isolated mkdtemp fixture; symlinks deliberately exercise the real CLI boundary. */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const binary = resolve('dist/index.js');
const execute = promisify(execFile);
let fixture: string;

afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('ci init symlink containment', () => {
  async function setup() {
    fixture = await realpath(await mkdtemp(join(tmpdir(), 'testsprite-ci-path-')));
    const repo = join(fixture, 'repo');
    const outside = join(fixture, 'outside');
    const home = join(fixture, 'home');
    await Promise.all([repo, outside, home].map(dir => mkdir(dir)));
    return { repo, outside, home };
  }

  async function run(cwd: string, home: string, force = false, workflowPath?: string) {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ environments: [{ name: 'staging', isDefault: true }] }));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address() as { port: number };
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
      for (const key of Object.keys(env)) {
        if (key.startsWith('TESTSPRITE_')) delete env[key];
      }
      return await execute(
        process.execPath,
        [
          binary,
          '--endpoint-url',
          `http://127.0.0.1:${address.port}`,
          'ci',
          'init',
          'github',
          '--project',
          'dummy-project',
          '--env',
          'staging',
          ...(force ? ['--force'] : []),
          ...(workflowPath ? ['--path', workflowPath] : []),
        ],
        {
          cwd,
          env: {
            ...env,
            TESTSPRITE_API_KEY: 'sk-user-local-only',
            TESTSPRITE_NO_TELEMETRY: '1',
            TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
          },
          timeout: 10000,
        },
      ).then(
        result => ({ ...result, code: 0 }),
        error => ({
          stdout: error.stdout as string,
          stderr: error.stderr as string,
          code: error.code as number,
        }),
      );
    } finally {
      await new Promise<void>((done, reject) =>
        server.close(error => (error ? reject(error) : done())),
      );
    }
  }

  for (const location of [
    '.github',
    '.github/workflows',
    '.github/workflows/testsprite.yml',
    '.github/workflows/testsprite.yml.bak',
  ]) {
    it(`refuses external ${location} before writing`, async () => {
      const { repo, outside, home } = await setup();
      const target =
        location.endsWith('.yml') || location.endsWith('.bak')
          ? join(outside, 'sentinel')
          : outside;
      if (target !== outside) await writeFile(target, 'unchanged');
      const link = join(repo, location);
      await mkdir(dirname(link), { recursive: true });
      if (location.endsWith('.bak'))
        await writeFile(join(repo, '.github/workflows/testsprite.yml'), 'original workflow');
      await symlink(target, link);
      const result = await run(repo, home, true);
      expect(result.code, result.stderr).toBe(5);
      expect(result.stderr).toContain(target);
      expect(await readdir(outside)).toEqual(target === outside ? [] : ['sentinel']);
      if (target !== outside) expect(await readFile(target, 'utf8')).toBe('unchanged');
      if (location.endsWith('.bak'))
        expect(await readFile(join(repo, '.github/workflows/testsprite.yml'), 'utf8')).toBe(
          'original workflow',
        );
    });
  }

  for (const location of ['.github', '.github/workflows', '.github/workflows/testsprite.yml']) {
    it(`allows internal ${location}`, async () => {
      const { repo, home } = await setup();
      const target = join(repo, 'internal');
      if (location.endsWith('.yml')) await writeFile(target, 'original workflow');
      else await mkdir(target);
      const link = join(repo, location);
      await mkdir(dirname(link), { recursive: true });
      await symlink(target, link);
      const result = await run(repo, home, true);
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(join(repo, '.github/workflows/testsprite.yml'), 'utf8')).toContain(
        'dummy-project',
      );
    });
  }

  it('refuses a dangling external ancestor without creating its target', async () => {
    const { repo, outside, home } = await setup();
    await symlink(join(outside, 'missing'), join(repo, '.github'));
    const result = await run(repo, home);
    expect(result.code, result.stderr).toBe(5);
    expect(await readdir(outside)).toEqual([]);
  });

  it('checks a literal backslash in a POSIX workflow filename', async () => {
    const { repo, outside, home } = await setup();
    const workflowPath = '.github/workflows/a\\b.yml';
    const target = join(outside, 'sentinel');
    await mkdir(join(repo, '.github/workflows'), { recursive: true });
    await writeFile(target, 'unchanged');
    await symlink(target, join(repo, workflowPath));
    const result = await run(repo, home, true, workflowPath);
    expect(result.code, result.stderr).toBe(5);
    expect(result.stderr).toContain(target);
    expect(await readFile(target, 'utf8')).toBe('unchanged');
  });

  it('allows a symlinked working directory', async () => {
    const { repo, home } = await setup();
    const alias = join(fixture, 'alias');
    await symlink(repo, alias);
    const result = await run(alias, home);
    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(join(repo, '.github/workflows/testsprite.yml'), 'utf8')).toContain(
      'dummy-project',
    );
  });
});
