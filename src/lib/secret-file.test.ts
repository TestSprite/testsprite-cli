import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors.js';
import { MAX_SECRET_FILE_BYTES, readSecretFileGuarded } from './secret-file.js';

// The size cap only earns its keep if it rejects before the read, so the
// oversize case asserts readFileSync was never reached. Delegates to the real
// implementation — every other case here reads a real file off disk.
vi.mock('node:fs', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, readFileSync: vi.fn(actual.readFileSync as typeof readFileSync) };
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

  describe('size cap', () => {
    /** Write a file of exactly `bytes` length. */
    const writeSized = (name: string, bytes: number): string => {
      const path = join(tmpRoot, name);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture: `name` is a literal supplied by each test, joined onto this suite's own mkdtempSync() root, never user input.
      writeFileSync(path, 'a'.repeat(bytes));
      return path;
    };

    it('reads a file sitting exactly on the cap', () => {
      const path = writeSized('at-cap.txt', MAX_SECRET_FILE_BYTES);
      expect(readSecretFileGuarded('password-file', path)).toHaveLength(MAX_SECRET_FILE_BYTES);
    });

    it('rejects one byte over the cap with PAYLOAD_TOO_LARGE, exit 5', () => {
      const path = writeSized('over-cap.txt', MAX_SECRET_FILE_BYTES + 1);
      try {
        readSecretFileGuarded('password-file', path);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', exitCode: 5 });
      }
    });

    it('reports the offending size and the cap in details', () => {
      const path = writeSized('details.txt', MAX_SECRET_FILE_BYTES + 512);
      try {
        readSecretFileGuarded('password-file', path);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as ApiError).details).toMatchObject({
          field: 'password-file',
          sizeBytes: MAX_SECRET_FILE_BYTES + 512,
          maxBytes: MAX_SECRET_FILE_BYTES,
        });
      }
    });

    it('names whichever flag the caller supplied', () => {
      const path = writeSized('other-flag.txt', MAX_SECRET_FILE_BYTES + 1);
      try {
        readSecretFileGuarded('credential-file', path);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as ApiError).nextAction).toContain('--credential-file');
      }
    });

    it('does not read the file into memory before rejecting it', () => {
      // The point of a stat-based cap is that an oversize file is never pulled
      // into the process at all — a cap enforced after the read would still
      // let a multi-gigabyte path exhaust memory.
      const path = writeSized('never-read.txt', MAX_SECRET_FILE_BYTES + 1);
      vi.mocked(readFileSync).mockClear();
      try {
        readSecretFileGuarded('password-file', path);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
        expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
      }
    });
  });
});
