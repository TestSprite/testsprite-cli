import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFreshBuild } from '../../test/helpers/assertFreshBuild.js';
import { ApiError } from './errors.js';
import { readSecretFileGuarded } from './secret-file.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_SECRET_FILE = join(REPO_ROOT, 'dist', 'lib', 'secret-file.js');

// readSecretFileGuarded reads the file body through the fd it already
// opened, via node:fs's readFileSync(fd, ...) overload. Mock openSync and
// readFileSync so a failure at either step (open, or a read after a
// successful open) can be exercised without one actually occurring; every
// other node:fs call the fixtures below use (mkdirSync, mkdtempSync,
// writeFileSync, chmodSync) stays real via the default pass-through
// implementation. vitest's mockReset() reverts a `vi.fn(impl)` double to
// that original `impl`, so resetting these after each test that mocks them
// puts both back on the real fs calls.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, openSync: vi.fn(actual.openSync), readFileSync: vi.fn(actual.readFileSync) };
});

let tmpRoot: string;
const originalCwd = process.cwd();

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'testsprite-secret-file-'));
});

afterEach(() => {
  // mkdtempSync directory is small and short-lived; OS cleans it up.
  process.chdir(originalCwd);
});

describe('readSecretFileGuarded', () => {
  it('returns the file contents', () => {
    const path = join(tmpRoot, 'pw.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (tmpRoot), not user input.
    writeFileSync(path, 'hunter2');
    expect(readSecretFileGuarded('password-file', path)).toBe('hunter2');
  });

  it('trims surrounding whitespace and the trailing newline', () => {
    const path = join(tmpRoot, 'pw-newline.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (tmpRoot), not user input.
    writeFileSync(path, '  hunter2  \n');
    expect(readSecretFileGuarded('password-file', path)).toBe('hunter2');
  });

  it('drops a leading UTF-8 BOM so PowerShell-written files still work', () => {
    const path = join(tmpRoot, 'pw-bom.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (tmpRoot), not user input.
    writeFileSync(path, '﻿hunter2\n');
    expect(readSecretFileGuarded('password-file', path)).toBe('hunter2');
  });

  it('preserves interior whitespace', () => {
    const path = join(tmpRoot, 'pw-spaces.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (tmpRoot), not user input.
    writeFileSync(path, 'two words\n');
    expect(readSecretFileGuarded('password-file', path)).toBe('two words');
  });

  it('resolves a relative path against the working directory', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (tmpRoot), not user input.
    writeFileSync(join(tmpRoot, 'relative.txt'), 'from-cwd');
    process.chdir(tmpRoot);
    expect(readSecretFileGuarded('password-file', 'relative.txt')).toBe('from-cwd');
  });

  it('returns an empty string for an empty file rather than throwing', () => {
    const path = join(tmpRoot, 'empty.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (tmpRoot), not user input.
    writeFileSync(path, '');
    expect(readSecretFileGuarded('password-file', path)).toBe('');
  });

  describe('missing file', () => {
    it('throws VALIDATION_ERROR with exit code 5', () => {
      const path = join(tmpRoot, 'nope.txt');
      expect(() => readSecretFileGuarded('password-file', path)).toThrow(ApiError);
      try {
        readSecretFileGuarded('password-file', path);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
      }
    });

    it('names the offending flag and path in nextAction', () => {
      const path = join(tmpRoot, 'nope.txt');
      try {
        readSecretFileGuarded('password-file', path);
        expect.unreachable('should have thrown');
      } catch (err) {
        const { nextAction } = err as ApiError;
        expect(nextAction).toContain('--password-file');
        expect(nextAction).toContain('file does not exist');
        expect(nextAction).toContain(path);
      }
    });

    it('attributes the error to whichever flag the caller names', () => {
      const path = join(tmpRoot, 'nope.txt');
      try {
        readSecretFileGuarded('client-secret-file', path);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as ApiError).nextAction).toContain('--client-secret-file');
      }
    });

    it('reports the path as typed, not the resolved absolute path', () => {
      process.chdir(tmpRoot);
      try {
        readSecretFileGuarded('password-file', 'missing.txt');
        expect.unreachable('should have thrown');
      } catch (err) {
        const { nextAction } = err as ApiError;
        expect(nextAction).toContain('missing.txt');
        expect(nextAction).not.toContain(tmpRoot);
      }
    });
  });

  describe('directory instead of a file', () => {
    it('throws VALIDATION_ERROR instead of crashing with EISDIR', () => {
      const path = join(tmpRoot, 'a-directory');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture directory created inside this test's own mkdtempSync-created temp dir (tmpRoot), not user input.
      mkdirSync(path);
      try {
        readSecretFileGuarded('password-file', path);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
        expect((err as ApiError).nextAction).toContain('not a regular file');
      }
    });
  });

  describe('permission denied', () => {
    // POSIX-only premise: a 0o000 mode has no effect on Windows ACLs, and
    // this repo's other permission-mode tests (credentials.test.ts) skip the
    // same way rather than emulate the ACL side.
    it.skipIf(process.platform === 'win32')(
      'reports permission denied rather than crashing',
      () => {
        const path = join(tmpRoot, 'locked.txt');
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (tmpRoot), not user input.
        writeFileSync(path, 'hunter2');
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- same test fixture path as the write above.
        chmodSync(path, 0o000);
        try {
          readSecretFileGuarded('password-file', path);
          expect.unreachable('should have thrown');
        } catch (err) {
          expect(err).toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
          expect((err as ApiError).nextAction).toContain('permission denied');
          expect((err as ApiError).nextAction).toContain(path);
        }
      },
    );
  });

  describe('named pipe (FIFO) instead of a file', () => {
    // A plain open(O_RDONLY) on a FIFO blocks until a writer connects
    // (POSIX fifo(7)), and since fs.openSync is synchronous, that blocks
    // whatever process calls it -- with no way for that process's OWN
    // timers (including a vitest test timeout) to interrupt it, because
    // the event loop that would run them is exactly what's blocked.
    // Verified directly: a worker process parked in this call ignored its
    // own vitest test timeout entirely and had to be `kill -9`'d from
    // outside. So this test cannot exercise the guard in-process -- it
    // spawns a real child instead, and the timeout that catches a
    // regression is enforced by THIS (unblocked) parent via spawnSync's
    // `timeout` option, which can reach in and kill a hung child from the
    // outside the way nothing inside that child can.
    it.skipIf(process.platform === 'win32')(
      'rejects a FIFO immediately instead of blocking for a writer',
      () => {
        assertFreshBuild(REPO_ROOT, DIST_SECRET_FILE);
        const path = join(tmpRoot, 'a-fifo');
        execFileSync('mkfifo', [path]);
        const childScript = join(tmpRoot, 'fifo-child.mjs');
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (tmpRoot), not user input.
        writeFileSync(
          childScript,
          [
            `import { readSecretFileGuarded } from ${JSON.stringify(DIST_SECRET_FILE)};`,
            'try {',
            "  readSecretFileGuarded('password-file', process.argv[2]);",
            "  process.stdout.write('NO_THROW');",
            '} catch (err) {',
            "  process.stdout.write('THREW:' + (err && err.nextAction ? err.nextAction : String(err)));",
            '}',
          ].join('\n'),
        );
        const result = spawnSync(process.execPath, [childScript, path], {
          timeout: 3000,
          killSignal: 'SIGKILL',
          encoding: 'utf8',
        });
        // A regression (a plain blocking open) means spawnSync's own
        // timeout had to step in and kill the child -- fail loudly with
        // that distinction rather than just asserting on stdout, so a
        // re-regression reads as "hung and was killed" instead of a
        // opaque empty-stdout assertion failure.
        expect(result.signal, `child was killed (likely hung): ${result.error}`).toBeNull();
        expect(result.stdout).toContain('THREW:');
        expect(result.stdout).toContain('not a regular file');
      },
      5000,
    );
  });

  describe('file descriptor table exhausted (EMFILE/ENFILE)', () => {
    afterEach(() => {
      vi.mocked(openSync).mockReset();
    });

    it('reports "cannot read" rather than "cannot stat", matching the old stat-then-read wording', () => {
      const path = join(tmpRoot, 'pw.txt');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (tmpRoot), not user input.
      writeFileSync(path, 'hunter2');
      vi.mocked(openSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
      });
      try {
        readSecretFileGuarded('password-file', path);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
        const { nextAction } = err as ApiError;
        expect(nextAction).toContain('cannot read');
        expect(nextAction).not.toContain('cannot stat');
        expect(nextAction).toContain(path);
        expect(nextAction).toContain('too many open files');
      }
    });
  });

  describe('read fails after a successful open', () => {
    afterEach(() => {
      // mockImplementationOnce below is self-consuming, but reset explicitly
      // rather than rely on that: mockReset() on a vi.fn(actual.fn) double
      // puts it back on its original (real fs) implementation (matching the
      // node:fs mock convention already used in init.test.ts), so a failure
      // partway through this test can't leave later tests reading nothing.
      vi.mocked(readFileSync).mockReset();
    });

    it('maps the failure onto VALIDATION_ERROR instead of throwing the raw error', () => {
      const path = join(tmpRoot, 'pw.txt');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (tmpRoot), not user input.
      writeFileSync(path, 'hunter2');
      vi.mocked(readFileSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('input/output error'), { code: 'EIO' });
      });
      try {
        readSecretFileGuarded('password-file', path);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
        const { nextAction } = err as ApiError;
        expect(nextAction).toContain('cannot read');
        expect(nextAction).toContain(path);
        expect(nextAction).toContain('input/output error');
      }
    });
  });
});
