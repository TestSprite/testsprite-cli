import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { isInScope, scanContent, scanTree } from './check-ticket-refs.mjs';

const script = fileURLToPath(new URL('./check-ticket-refs.mjs', import.meta.url));

// Ticket refs are built by concatenation, never typed as one literal token,
// so this test file does not itself trip the guard it is testing.
const ref = (prefix, num) => `${prefix}-${num}`;

// ---------------------------------------------------------------------------
// scanContent — pure line-matching logic
// ---------------------------------------------------------------------------

test('flags a ticket ref inside a source comment', () => {
  const content = `const x = 1;\n// see ${ref('DEV', 123)} for context\n`;
  const hits = scanContent(content, 'src/foo.ts');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].filePath, 'src/foo.ts');
  assert.match(hits[0].text, new RegExp(ref('DEV', 123)));
});

test('flags a ticket ref inside a YAML comment', () => {
  const content = `steps:\n  - run: echo hi # workaround for ${ref('TES', 456)}\n`;
  const hits = scanContent(content, '.github/workflows/example.yml');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
});

test('reports correct line numbers, including a hit that is not on the first match', () => {
  const content = [
    'line one',
    'line two',
    `line three ${ref('DES', 7)}`,
    'line four',
    `line five ${ref('DEV', 8)}`,
  ].join('\n');
  const hits = scanContent(content, 'test/example.spec.ts');
  assert.deepEqual(
    hits.map(h => h.line),
    [3, 5],
  );
});

test('handles CRLF input without leaving a trailing carriage return in the reported text', () => {
  const content = `first\r\nsecond ${ref('TES', 9)}\r\nthird\r\n`;
  const hits = scanContent(content, 'scripts/example.sh');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.doesNotMatch(hits[0].text, /\r/);
});

test('does not false-positive on look-alike identifiers or public issue numbers', () => {
  const content = [
    'TESTS-1 is not a ticket',
    'DEVICE-12 is not a ticket',
    'see #210 for the public issue this guards against',
    'TES on its own, with no number, is not a ticket',
  ].join('\n');
  assert.deepEqual(scanContent(content, 'src/bar.ts'), []);
});

test('ignores lowercase look-alikes such as a dev-<n> hostname or env slug', () => {
  const content = `const host = 'api.${ref('dev', 1)}.example.com';\nconst env = '${ref('tes', 456)}';\n`;
  assert.deepEqual(scanContent(content, 'src/baz.ts'), []);
});

// ---------------------------------------------------------------------------
// isInScope — path scoping rules
// ---------------------------------------------------------------------------

test('includes the named directory prefixes', () => {
  assert.equal(isInScope('src/lib/foo.ts'), true);
  assert.equal(isInScope('test/foo.spec.ts'), true);
  assert.equal(isInScope('.github/workflows/release-build.yml'), true);
  assert.equal(isInScope('scripts/tool.sh'), true);
  assert.equal(isInScope('copybara/copy.bara.sky'), true);
});

test('includes root config files by family, not one fixed list', () => {
  for (const path of [
    'package.json',
    'eslint.config.mjs',
    'eslint.security.config.mjs',
    'tsconfig.json',
    'tsconfig.build.json',
    'vitest.config.ts',
    'vitest.e2e.config.ts',
    'vitest.dev-e2e.config.ts',
    '.prettierrc',
  ]) {
    assert.equal(isInScope(path), true, path);
  }
});

test('excludes markdown docs anywhere in the tree', () => {
  assert.equal(isInScope('README.md'), false);
  assert.equal(isInScope('src/README.md'), false);
});

test('excludes the docs/ tree even for a non-.md file', () => {
  assert.equal(isInScope('docs/internal/notes.ts'), false);
  assert.equal(isInScope('docs/architecture.mdx'), false);
});

test('excludes CHANGELOG files anywhere in the tree', () => {
  assert.equal(isInScope('CHANGELOG.md'), false);
  assert.equal(isInScope('CHANGELOG'), false);
  assert.equal(isInScope('packages/sub/CHANGELOG.next.md'), false);
});

test('excludes the backport manifest and the lockfile', () => {
  assert.equal(isInScope('.backport-manifest'), false);
  assert.equal(isInScope('package-lock.json'), false);
});

test('does not sweep in an unrelated root dotfile', () => {
  assert.equal(isInScope('.npmrc'), false);
  assert.equal(isInScope('.gitattributes'), false);
});

test('matches a .prettierrc variant by family, same as the other root configs', () => {
  assert.equal(isInScope('.prettierrc.json'), true);
});

test('does not match a root file that merely resembles an included family', () => {
  assert.equal(isInScope('mytsconfig.json'), false);
  assert.equal(isInScope('random.config.mjs'), false);
});

test('a source-looking file outside every included prefix is out of scope', () => {
  assert.equal(isInScope('bin/tool.ts'), false);
});

// ---------------------------------------------------------------------------
// scanTree / CLI — end-to-end against a real (scratch) git checkout
// ---------------------------------------------------------------------------

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'check-ticket-refs-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'ci@example.com');
  git('config', 'user.name', 'ci');
  git('config', 'commit.gpgsign', 'false');
  return { root, git };
}

test('scanTree flags in-scope hits, exempts docs/md/manifest, and skips binary files', t => {
  const { root, git } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'docs', 'internal'), { recursive: true });

  writeFileSync(join(root, 'src', 'example.ts'), `// tracked here: ${ref('DEV', 111)}\n`);
  writeFileSync(
    join(root, '.github', 'workflows', 'example.yml'),
    `on: push # see ${ref('TES', 222)}\n`,
  );
  writeFileSync(join(root, 'scripts', 'tool.sh'), '#!/bin/sh\necho clean\n');
  writeFileSync(join(root, 'docs', 'internal', 'notes.ts'), `${ref('DES', 333)} — excluded\n`);
  writeFileSync(join(root, 'README.md'), `${ref('DEV', 444)} — excluded\n`);
  writeFileSync(join(root, '.backport-manifest'), `${ref('DEV', 555)} — excluded\n`);
  writeFileSync(
    join(root, 'src', 'blob.bin'),
    Buffer.concat([Buffer.from([0]), Buffer.from(`${ref('DEV', 666)} in binary\n`)]),
  );

  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');

  const { hits, scanned } = scanTree(root);
  const byFile = Object.fromEntries(hits.map(h => [h.filePath, h]));

  assert.equal(hits.length, 2);
  assert.ok(byFile['src/example.ts']);
  assert.equal(byFile['src/example.ts'].line, 1);
  assert.ok(byFile['.github/workflows/example.yml']);
  assert.equal(
    scanned,
    3,
    'binary file skipped; example.ts, example.yml, and clean tool.sh are counted; docs/md/manifest never read',
  );
});

test('CLI: exits 1 and prints path:line plus the explanatory line when refs are found', t => {
  const { root, git } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'example.ts'), `// leftover ${ref('DEV', 777)}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');

  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(String.raw`src/example\.ts:1: .*${ref('DEV', 777)}`));
  assert.match(result.stderr, /PR description or commit message/);
});

test('CLI: exits 0 and reports a clean scan when no refs are found', t => {
  const { root, git } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'example.ts'), 'export const ok = true;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');

  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /clean, 1 file\(s\) scanned/);
  assert.doesNotMatch(result.stderr, /:\d+: /);
});

test('scanTree still finds a hit committed elsewhere in the tree when run from a subdirectory', t => {
  const { root, git } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, '.github', 'workflows', 'example.yml'),
    `on: push # see ${ref('TES', 888)}\n`,
  );
  writeFileSync(join(root, 'scripts', 'tool.sh'), '#!/bin/sh\necho clean\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');

  // A plausible way to iterate on this script: cd into its own directory
  // and run it from there. `root` here is a subdirectory, not the repo top.
  const { hits, scanned } = scanTree(join(root, 'scripts'));
  assert.equal(scanned, 2);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].filePath, '.github/workflows/example.yml');
});

test('scanTree skips a tracked symlink instead of reading whatever it currently resolves to', t => {
  const { root, git } = makeRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'real.ts'), 'export const ok = true;\n');
  try {
    symlinkSync('real.ts', join(root, 'src', 'link.ts'));
  } catch {
    // Symlink creation can require elevated privilege on some Windows
    // configurations — skip rather than silently pass or fail the suite
    // over that.
    t.skip('symlink creation is not permitted in this environment');
    return;
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');

  const { hits, scanned } = scanTree(root);
  assert.equal(hits.length, 0);
  assert.equal(scanned, 1, 'only real.ts is read; link.ts is skipped, not double-counted');
});
