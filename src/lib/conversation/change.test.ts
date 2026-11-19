import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankSecrets, readChange, readRepository, type Git } from './change.js';

function fakeGit(answers: Record<string, string | null>): Git & { calls: string[][] } {
  const calls: string[][] = [];
  const git = ((args: string[]) => {
    calls.push(args);
    const key = Object.keys(answers).find(k => args.join(' ').startsWith(k));
    const out = key === undefined ? null : (answers[key] ?? null);
    return out === null ? { ok: false, stdout: '' } : { ok: true, stdout: out };
  }) as unknown as Git & { calls: string[][] };
  git.calls = calls;
  return git;
}

describe('readRepository', () => {
  it('names the repository, branch and commit', () => {
    const git = fakeGit({
      'rev-parse --show-toplevel': '/repo\n',
      'remote get-url origin': 'git@github.com:acme/shop.git\n',
      'rev-parse --abbrev-ref HEAD': 'feat/coupons\n',
      'rev-parse --short HEAD': '3f9a2c1\n',
    });
    expect(readRepository('/repo/src', git)).toEqual({
      root: '/repo',
      name: 'acme/shop',
      branch: 'feat/coupons',
      commit: '3f9a2c1',
    });
  });

  it('is null outside a repository', () => {
    expect(readRepository('/tmp', fakeGit({}))).toBeNull();
  });
});

describe('readChange', () => {
  it('diffs against where the branch left the default branch, with new files, minus secrets', () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-change-'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes into this test's own mkdtempSync repository.
    writeFileSync(join(root, 'coupon.ts'), 'export const LIMIT = 2;\n');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes into this test's own mkdtempSync repository.
    writeFileSync(join(root, '.env.local'), 'API_KEY=x\n');
    const git = fakeGit({
      'merge-base HEAD origin/HEAD': 'abc123\n',
      'diff --name-only abc123': 'src/cart.ts\nconfig/secrets.json\n',
      'diff --no-color --no-ext-diff abc123 -- src/cart.ts':
        'diff --git a/src/cart.ts b/src/cart.ts\n+x\n',
      'ls-files --others --exclude-standard': 'coupon.ts\n.env.local\n',
    });
    const change = readChange({ root }, undefined, git);
    expect(change.base).toBe('abc123');
    expect(change.files).toEqual(['src/cart.ts', 'coupon.ts']);
    expect(change.left).toEqual(['config/secrets.json', '.env.local']);
    expect(change.patch).toContain('diff --git a/src/cart.ts b/src/cart.ts');
    expect(change.patch).toContain('+++ b/coupon.ts\n@@ -0,0 +1,1 @@\n+export const LIMIT = 2;');
    expect(change.patch).not.toContain('API_KEY');
  });

  it('leaves out binary new files', () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-change-'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes into this test's own mkdtempSync repository.
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    const git = fakeGit({
      'diff --name-only HEAD': '',
      'ls-files --others --exclude-standard': 'logo.png\n',
    });
    expect(readChange({ root }, 'HEAD', git)).toMatchObject({ patch: '', left: ['logo.png'] });
  });

  it('refuses a base that does not exist', () => {
    expect(() => readChange({ root: '/repo' }, 'nope', fakeGit({}))).toThrow(/no such commit/);
  });
});

describe('blankSecrets', () => {
  it('blanks well-known credential formats wherever they appear', () => {
    // Built at run time so no credential-shaped literal sits in the source for secret scanners.
    const awsKey = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const text = blankSecrets(
      `+const key = "${awsKey}";\n+token: ghp_${'a'.repeat(36)}\n+ok = "plain"`,
    );
    expect(text).toBe('+const key = "[REDACTED]";\n+token: [REDACTED]\n+ok = "plain"');
  });
});
