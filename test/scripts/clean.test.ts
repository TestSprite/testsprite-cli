import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cleanScript = join(repositoryRoot, 'scripts', 'clean.mjs');

describe('scripts/clean.mjs', () => {
  it('removes existing generated directories and is safe to repeat', () => {
    const root = mkdtempSync(join(tmpdir(), 'testsprite-clean-'));
    const scripts = join(root, 'scripts');
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'coverage'), { recursive: true });
    writeFileSync(join(root, 'dist', 'bundle.js'), 'generated');
    writeFileSync(join(root, 'coverage', 'summary.json'), '{}');
    mkdirSync(scripts, { recursive: true });
    const copiedScript = join(scripts, 'clean.mjs');
    cpSync(cleanScript, copiedScript);
    chmodSync(copiedScript, 0o755);

    try {
      execFileSync(process.execPath, [copiedScript], { cwd: root, stdio: 'pipe' });
      expect(() =>
        execFileSync(process.execPath, [copiedScript], { cwd: root, stdio: 'pipe' }),
      ).not.toThrow();
      expect(existsSync(join(root, 'dist'))).toBe(false);
      expect(existsSync(join(root, 'coverage'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
