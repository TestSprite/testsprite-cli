import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';

const filterScript = fileURLToPath(new URL('./filter-changed-line-findings.mjs', import.meta.url));

// A throwaway repo with two commits: BASE has ten lines, HEAD rewrites line 3
// and appends lines 11–12. Findings are synthetic ESLint JSON so the test
// exercises only the filter's line scoping, not ESLint itself.
const repo = mkdtempSync(join(tmpdir(), 'filter-changed-lines-'));
after(() => rmSync(repo, { recursive: true, force: true }));

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q');
git('config', 'user.email', 'ci@example.com');
git('config', 'user.name', 'ci');
git('config', 'commit.gpgsign', 'false');
mkdirSync(join(repo, 'src'));
const baseLines = Array.from({ length: 10 }, (_, i) => `const line${i + 1} = ${i + 1};`);
writeFileSync(join(repo, 'src/a.ts'), `${baseLines.join('\n')}\n`);
git('add', '.');
git('commit', '-q', '-m', 'base');
const BASE = git('rev-parse', 'HEAD');
const headLines = [...baseLines];
headLines[2] = 'const line3 = readFileSync(userPath);';
headLines.push('const line11 = 11;', 'const line12 = readFileSync(otherPath);');
writeFileSync(join(repo, 'src/a.ts'), `${headLines.join('\n')}\n`);
git('commit', '-q', '-am', 'head');
const HEAD = git('rev-parse', 'HEAD');

function runFilter(messages, { base = BASE } = {}) {
  const reportPath = join(repo, `report-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(reportPath, JSON.stringify([{ filePath: join(repo, 'src/a.ts'), messages }]));
  const result = spawnSync(process.execPath, [filterScript, reportPath], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, RESOLVED_BASE: base, HEAD_SHA: HEAD },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const finding = (line, severity = 2) => ({
  line,
  column: 1,
  severity,
  ruleId: 'security/detect-non-literal-fs-filename',
  message: 'Found readFileSync from package "fs" with non literal argument',
});

test('an error on an added line fails the gate', () => {
  const { status, output } = runFilter([finding(12)]);
  assert.equal(status, 1);
  assert.match(output, /src\/a\.ts:12:1/);
});

test('an error on a modified line fails the gate', () => {
  assert.equal(runFilter([finding(3)]).status, 1);
});

test('errors only on untouched legacy lines pass', () => {
  const { status, output } = runFilter([finding(5), finding(9)]);
  assert.equal(status, 0);
  assert.match(output, /no error findings on changed lines/);
});

test('a relocated finding is reported even when the per-file count is unchanged', () => {
  // The raw report is what reaches the filter: one legacy finding on an
  // untouched line plus one new finding on an added line. A count-based
  // baseline of "one finding in this file" would have hidden the new one.
  const { status, output } = runFilter([finding(7), finding(12)]);
  assert.equal(status, 1);
  assert.match(output, /src\/a\.ts:12:1/);
  assert.doesNotMatch(output, /src\/a\.ts:7:1/);
});

test('warnings on added lines do not fail the gate', () => {
  assert.equal(runFilter([finding(12, 1)]).status, 0);
});

test('without a base every error is kept', () => {
  assert.equal(runFilter([finding(5)], { base: '' }).status, 1);
});
