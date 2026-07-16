import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  isInsideGitRepo,
  isTestspriteIgnored,
  checkTestspriteIgnored,
  ensureTestspriteIgnored,
} from './git-utils.js';

describe('git-utils', () => {
  describe('isInsideGitRepo', () => {
    it('returns true if .git exists in the current directory', () => {
      const mockExists = (p: string) => p === join('/foo/bar', '.git');
      expect(isInsideGitRepo('/foo/bar', { existsSync: mockExists })).toBe(true);
    });

    it('returns true if .git exists in a parent directory', () => {
      const mockExists = (p: string) => p === join('/foo', '.git');
      expect(isInsideGitRepo('/foo/bar/baz', { existsSync: mockExists })).toBe(true);
    });

    it('returns false if .git is not found anywhere up the tree', () => {
      const mockExists = () => false;
      expect(isInsideGitRepo('/foo/bar/baz', { existsSync: mockExists })).toBe(false);
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
      expect(isTestspriteIgnored('**/.testsprite/runs')).toBe(true);
    });

    it('ignores comments and empty lines', () => {
      expect(isTestspriteIgnored('# .testsprite/')).toBe(false);
      expect(isTestspriteIgnored('   # comment\n.testsprite/')).toBe(true);
    });

    it('returns false if unrelated folders are ignored', () => {
      expect(isTestspriteIgnored('node_modules/\ndist/')).toBe(false);
    });

    it('correctly handles negation patterns (un-ignoring)', () => {
      expect(isTestspriteIgnored('.testsprite/\n!.testsprite/')).toBe(false);
      expect(isTestspriteIgnored('!.testsprite/\n.testsprite/')).toBe(true);
      expect(isTestspriteIgnored('**/.testsprite/\n!**/.testsprite/')).toBe(false);
      expect(isTestspriteIgnored('.testsprite/*\n!.testsprite/')).toBe(false);
    });
  });

  describe('checkTestspriteIgnored', () => {
    it('returns false if .gitignore does not exist', async () => {
      const mockExists = () => false;
      const mockRead = async () => '';
      await expect(checkTestspriteIgnored('/foo', { existsSync: mockExists, readFile: mockRead })).resolves.toBe(false);
    });

    it('returns true if .gitignore exists and ignores .testsprite', async () => {
      const mockExists = (p: string) => p === join('/foo', '.gitignore');
      const mockRead = async () => 'dist/\n.testsprite/';
      await expect(checkTestspriteIgnored('/foo', { existsSync: mockExists, readFile: mockRead })).resolves.toBe(true);
    });

    it('returns false if .gitignore exists but does not ignore .testsprite', async () => {
      const mockExists = (p: string) => p === join('/foo', '.gitignore');
      const mockRead = async () => 'dist/';
      await expect(checkTestspriteIgnored('/foo', { existsSync: mockExists, readFile: mockRead })).resolves.toBe(false);
    });
  });

  describe('ensureTestspriteIgnored', () => {
    it('creates .gitignore and appends .testsprite if file does not exist', async () => {
      let writtenContent = '';
      const mockExists = () => false;
      const mockRead = async () => '';
      const mockWrite = async (p: string, content: string) => {
        writtenContent = content;
      };

      const result = await ensureTestspriteIgnored('/foo', {
        existsSync: mockExists,
        readFile: mockRead,
        writeFile: mockWrite,
      });

      expect(result).toBe(true);
      expect(writtenContent).toContain('.testsprite/');
    });

    it('appends .testsprite if .gitignore exists but does not ignore it', async () => {
      let writtenContent = '';
      const mockExists = () => true;
      const mockRead = async () => 'node_modules/\ndist/';
      const mockWrite = async (p: string, content: string) => {
        writtenContent = content;
      };

      const result = await ensureTestspriteIgnored('/foo', {
        existsSync: mockExists,
        readFile: mockRead,
        writeFile: mockWrite,
      });

      expect(result).toBe(true);
      expect(writtenContent).toBe('node_modules/\ndist/\n\n# TestSprite failure artifacts\n.testsprite/\n');
    });

    it('does not modify .gitignore if .testsprite is already ignored', async () => {
      let calledWrite = false;
      const mockExists = () => true;
      const mockRead = async () => 'node_modules/\n.testsprite/';
      const mockWrite = async () => {
        calledWrite = true;
      };

      const result = await ensureTestspriteIgnored('/foo', {
        existsSync: mockExists,
        readFile: mockRead,
        writeFile: mockWrite,
      });

      expect(result).toBe(false);
      expect(calledWrite).toBe(false);
    });
  });
});
