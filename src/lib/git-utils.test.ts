import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import {
  isInsideGitRepo,
  isInsideGitRepoAsync,
  isTestspriteIgnored,
  checkTestspriteIgnored,
  ensureTestspriteIgnored,
  findGitRoot,
  inspectTestspriteIgnore,
} from './git-utils.js';

describe('git-utils', () => {
  describe('isInsideGitRepo', () => {
    it('returns true if .git exists in the current directory', () => {
      const mockExists = (p: string) => p === join(resolve('/foo/bar'), '.git');
      expect(isInsideGitRepo(resolve('/foo/bar'), { existsSync: mockExists })).toBe(true);
    });

    it('returns true if .git exists in a parent directory', () => {
      const mockExists = (p: string) => p === join(resolve('/foo'), '.git');
      expect(isInsideGitRepo(resolve('/foo/bar/baz'), { existsSync: mockExists })).toBe(true);
    });

    it('returns false if .git is not found anywhere up the tree', () => {
      const mockExists = () => false;
      expect(isInsideGitRepo(resolve('/foo/bar/baz'), { existsSync: mockExists })).toBe(false);
    });
  });

  describe('isInsideGitRepoAsync', () => {
    it('returns true if .git exists in the current directory (async)', async () => {
      const mockExists = async (p: string) => p === join(resolve('/foo/bar'), '.git');
      await expect(isInsideGitRepoAsync(resolve('/foo/bar'), { exists: mockExists })).resolves.toBe(
        true,
      );
    });

    it('returns true if .git exists in a parent directory (async)', async () => {
      const mockExists = async (p: string) => p === join(resolve('/foo'), '.git');
      await expect(
        isInsideGitRepoAsync(resolve('/foo/bar/baz'), { exists: mockExists }),
      ).resolves.toBe(true);
    });

    it('returns false if .git is not found anywhere up the tree (async)', async () => {
      const mockExists = async () => false;
      await expect(
        isInsideGitRepoAsync(resolve('/foo/bar/baz'), { exists: mockExists }),
      ).resolves.toBe(false);
    });
  });

  describe('isTestspriteIgnored', () => {
    it('returns false for empty content', () => {
      expect(isTestspriteIgnored('')).toBe(false);
    });

    it('returns true if .testsprite is explicitly ignored', () => {
      expect(isTestspriteIgnored('.testsprite')).toBe(true);
      expect(isTestspriteIgnored('.testsprite/')).toBe(true);
      expect(isTestspriteIgnored('**/.testsprite')).toBe(true);
      expect(isTestspriteIgnored('**/.testsprite/')).toBe(true);
    });

    it('returns true if .testsprite subfolders or files are ignored', () => {
      expect(isTestspriteIgnored('.testsprite/*')).toBe(true);
      expect(isTestspriteIgnored('**/.testsprite/*')).toBe(true);
      expect(isTestspriteIgnored('**/.testsprite/runs')).toBe(false);
    });

    it('ignores comments and empty lines', () => {
      expect(isTestspriteIgnored('# .testsprite/')).toBe(false);
      expect(isTestspriteIgnored('   # comment\n.testsprite/')).toBe(true);
      expect(isTestspriteIgnored('.testsprite/ # not a comment in git')).toBe(false);
    });

    it('returns false if unrelated folders are ignored', () => {
      expect(isTestspriteIgnored('node_modules/\ndist/')).toBe(false);
    });

    it('correctly handles negation patterns (un-ignoring)', () => {
      expect(isTestspriteIgnored('.testsprite/\n!.testsprite/')).toBe(false);
      expect(isTestspriteIgnored('!.testsprite/\n.testsprite/')).toBe(true);
      expect(isTestspriteIgnored('**/.testsprite/\n!**/.testsprite/')).toBe(false);
      expect(isTestspriteIgnored('.testsprite/*\n!.testsprite/')).toBe(false);
      expect(isTestspriteIgnored('.testsprite/*\n!.testsprite/secret')).toBe(false);
      expect(isTestspriteIgnored('**/.testsprite/*\n!**/.testsprite/runs')).toBe(false);
      expect(isTestspriteIgnored('.testsprite/\n!.testsprite/secret')).toBe(true);
    });
  });

  describe('checkTestspriteIgnored', () => {
    it('returns false if .gitignore does not exist', async () => {
      const mockExists = () => false;
      const mockRead = async () => '';
      await expect(
        checkTestspriteIgnored(resolve('/foo'), { existsSync: mockExists, readFile: mockRead }),
      ).resolves.toBe(false);
    });

    it('returns true if .gitignore exists and ignores .testsprite', async () => {
      const mockExists = (p: string) => p === join(resolve('/foo'), '.gitignore');
      const mockRead = async () => 'dist/\n.testsprite/';
      await expect(
        checkTestspriteIgnored(resolve('/foo'), { existsSync: mockExists, readFile: mockRead }),
      ).resolves.toBe(true);
    });

    it('returns false if .gitignore exists but does not ignore .testsprite', async () => {
      const mockExists = (p: string) => p === join(resolve('/foo'), '.gitignore');
      const mockRead = async () => 'dist/';
      await expect(
        checkTestspriteIgnored(resolve('/foo'), { existsSync: mockExists, readFile: mockRead }),
      ).resolves.toBe(false);
    });
  });

  describe('isTestspriteIgnored line endings and whitespace', () => {
    it('handles CRLF content and trailing spaces', () => {
      expect(isTestspriteIgnored('node_modules/\r\n.testsprite/  \r\n')).toBe(true);
    });

    it('handles content without a trailing newline', () => {
      expect(isTestspriteIgnored('node_modules/\n.testsprite/')).toBe(true);
    });
  });

  describe('findGitRoot', () => {
    it('resolves a relative dir before walking up', () => {
      const root = resolve('.');
      const mockExists = (p: string) => p === join(root, '.git');
      expect(findGitRoot(join('some', 'sub'), { existsSync: mockExists })).toBe(root);
    });

    it('treats .git as a file (worktree or submodule) the same as a directory', () => {
      // existsSync is true for both files and directories; the walker only asks for existence.
      const mockExists = (p: string) => p === join('/wt', '.git');
      expect(findGitRoot('/wt/pkg', { existsSync: mockExists })).toBe(resolve('/wt'));
    });
  });

  describe('inspectTestspriteIgnore', () => {
    const repo = resolve('/repo');
    const files = new Map<string, string>();
    const deps = () => ({
      existsSync: (p: string) => p === join(repo, '.git') || files.has(p),
      readFileSync: (p: string) => files.get(p) ?? '',
    });

    it('reports not in repo when no .git is found', () => {
      expect(inspectTestspriteIgnore('/nowhere/x', { existsSync: () => false })).toEqual({
        inRepo: false,
        ignored: false,
      });
    });

    it('finds a rule in the repo-root .gitignore from a subdirectory', () => {
      files.clear();
      files.set(join(repo, '.gitignore'), 'node_modules/\n.testsprite/\n');
      expect(inspectTestspriteIgnore(join(repo, 'a', 'b'), deps())).toEqual({
        inRepo: true,
        ignored: true,
      });
    });

    it('reports not ignored when no .gitignore up to the root has the rule', () => {
      files.clear();
      files.set(join(repo, 'a', '.gitignore'), 'dist/\n');
      expect(inspectTestspriteIgnore(join(repo, 'a'), deps())).toEqual({
        inRepo: true,
        ignored: false,
      });
    });
  });

  describe('ensureTestspriteIgnored', () => {
    const repoDeps = (extra: Record<string, unknown> = {}) => {
      const appended: Array<{ p: string; text: string }> = [];
      return {
        appended,
        deps: {
          existsSync: (p: string) => p === join(resolve('/foo'), '.git'),
          lstat: async () => null,
          readFile: async () => '',
          appendFile: async (p: string, text: string) => {
            appended.push({ p, text });
          },
          ...extra,
        },
      };
    };

    it('creates .gitignore by appending the entry inside a git repo', async () => {
      const { appended, deps } = repoDeps();
      expect(await ensureTestspriteIgnored(resolve('/foo'), deps)).toBe(true);
      expect(appended).toEqual([
        {
          p: join(resolve('/foo'), '.gitignore'),
          text: '\n# TestSprite failure artifacts\n.testsprite/\n',
        },
      ]);
    });

    it('does nothing outside a git repo', async () => {
      const { appended, deps } = repoDeps({ existsSync: () => false });
      expect(await ensureTestspriteIgnored(resolve('/foo'), deps)).toBe(false);
      expect(appended).toEqual([]);
    });

    it('appends only the new chunk and keeps a leading newline when the file has no trailing newline', async () => {
      const { appended, deps } = repoDeps({
        existsSync: (p: string) =>
          p === join(resolve('/foo'), '.git') || p === join(resolve('/foo'), '.gitignore'),
        lstat: async () => ({ isSymbolicLink: false }),
        readFile: async () => 'node_modules/\ndist/',
      });
      expect(await ensureTestspriteIgnored(resolve('/foo'), deps)).toBe(true);
      expect(appended).toHaveLength(1);
      expect(appended[0]!.text).toBe('\n\n# TestSprite failure artifacts\n.testsprite/\n');
    });

    it('handles CRLF files without adding an extra separator newline', async () => {
      const { appended, deps } = repoDeps({
        lstat: async () => ({ isSymbolicLink: false }),
        readFile: async () => 'dist/\r\n',
      });
      expect(await ensureTestspriteIgnored(resolve('/foo'), deps)).toBe(true);
      expect(appended[0]!.text).toBe('\n# TestSprite failure artifacts\n.testsprite/\n');
    });

    it('does not modify .gitignore if .testsprite is already ignored', async () => {
      const { appended, deps } = repoDeps({
        lstat: async () => ({ isSymbolicLink: false }),
        readFile: async () => 'node_modules/\n.testsprite/',
      });
      expect(await ensureTestspriteIgnored(resolve('/foo'), deps)).toBe(false);
      expect(appended).toEqual([]);
    });

    it('refuses to write through a symlinked .gitignore', async () => {
      const { appended, deps } = repoDeps({ lstat: async () => ({ isSymbolicLink: true }) });
      await expect(ensureTestspriteIgnored(resolve('/foo'), deps)).rejects.toThrow(/symlink/);
      expect(appended).toEqual([]);
    });

    it('detects the repo from a relative dir via the resolved path', async () => {
      const root = resolve('.');
      const { appended, deps } = repoDeps({ existsSync: (p: string) => p === join(root, '.git') });
      expect(await ensureTestspriteIgnored(join('pkg', 'a'), deps)).toBe(true);
      expect(appended[0]!.p).toBe(join(root, 'pkg', 'a', '.gitignore'));
    });
  });
});
