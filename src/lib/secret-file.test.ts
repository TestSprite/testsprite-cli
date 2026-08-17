import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import { readSecretFileGuarded } from './secret-file.js';

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
    writeFileSync(path, 'hunter2');
    expect(readSecretFileGuarded('password-file', path)).toBe('hunter2');
  });

  it('trims surrounding whitespace and the trailing newline', () => {
    const path = join(tmpRoot, 'pw-newline.txt');
    writeFileSync(path, '  hunter2  \n');
    expect(readSecretFileGuarded('password-file', path)).toBe('hunter2');
  });

  it('drops a leading UTF-8 BOM so PowerShell-written files still work', () => {
    const path = join(tmpRoot, 'pw-bom.txt');
    writeFileSync(path, '﻿hunter2\n');
    expect(readSecretFileGuarded('password-file', path)).toBe('hunter2');
  });

  it('preserves interior whitespace', () => {
    const path = join(tmpRoot, 'pw-spaces.txt');
    writeFileSync(path, 'two words\n');
    expect(readSecretFileGuarded('password-file', path)).toBe('two words');
  });

  it('resolves a relative path against the working directory', () => {
    writeFileSync(join(tmpRoot, 'relative.txt'), 'from-cwd');
    process.chdir(tmpRoot);
    expect(readSecretFileGuarded('password-file', 'relative.txt')).toBe('from-cwd');
  });

  it('returns an empty string for an empty file rather than throwing', () => {
    const path = join(tmpRoot, 'empty.txt');
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
});
