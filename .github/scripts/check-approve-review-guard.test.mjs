import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanContent } from './check-approve-review-guard.mjs';

const script = fileURLToPath(new URL('./check-approve-review-guard.mjs', import.meta.url));
const auditScript = fileURLToPath(
  new URL('../../scripts/audit-org-pr-approval-workflows.sh', import.meta.url),
);
const publicSnapshot = !existsSync(
  fileURLToPath(new URL('../../scripts/apply-security-settings.sh', import.meta.url)),
);

function reasons(content, path = '.github/workflows/review.yml') {
  return scanContent(content, path).map(hit => hit.reason);
}

test('finds Octokit review submission calls', () => {
  assert.equal(reasons("await octokit.pulls.createReview({ event: 'APPROVE' })").length, 2);
  assert.equal(reasons('await github.rest.pulls.submitReview({})').length, 1);
  assert.equal(reasons('await octokit.reviews.create({})').length, 1);
});

test('finds REST and JSON approval events', () => {
  assert.equal(reasons("event: 'APPROVE'").length, 1);
  assert.equal(reasons('"event": "APPROVE"').length, 1);
  assert.equal(reasons('event: APPROVE').length, 1);
  assert.deepEqual(
    scanContent('"event":\n  "APPROVE"', '.github/workflows/review.yml').map(hit => hit.line),
    [2],
  );
  assert.deepEqual(reasons('event: COMMENT'), []);
  assert.deepEqual(reasons('url: https://example.test/?event=push'), []);
});

for (const flag of ['-f', '-F', '--field', '--raw-field']) {
  test(`finds gh api approval event with ${flag}`, () => {
    assert.equal(
      reasons(`gh api repos/TestSprite/example/pulls/1/reviews ${flag} event=APPROVE`).length,
      1,
    );
  });
}

test('finds gh approval commands, including commands split across lines', () => {
  assert.equal(reasons('gh pr review $PR --approve').length, 1);
  assert.equal(reasons('gh pr review "$PR" \\\n  --approve').length, 1);
});

test('finds the short gh pr review approval flag', () => {
  assert.equal(reasons('gh pr review "$PR" -a').length, 1);
});

test('finds the short gh pr review flag on a continued line', () => {
  assert.equal(reasons('gh pr review "$PR" \\\n  -a').length, 1);
});

test('scans bash case catch-all branches', () => {
  const content = 'run: |\n  case "$MODE" in\n    *) gh pr review "$PR" --approve ;;\n  esac';
  assert.deepEqual(
    scanContent(content, '.github/workflows/review.yml').map(hit => hit.line),
    [3],
  );
});

test('finds marketplace approval actions only in uses entries', () => {
  assert.equal(reasons('  - uses: hmarr/auto-approve-action@0123456789abcdef').length, 1);
  assert.equal(reasons('  uses: example/approve-pull-request-action@v1').length, 1);
  assert.deepEqual(reasons('description: hmarr/auto-approve-action@v4'), []);
});

test('accepts a reviewed exception on the same line with a reason', () => {
  assert.deepEqual(reasons('gh pr review $PR --approve # reviewed-exception: release bot'), []);
  assert.equal(reasons('gh pr review $PR --approve # reviewed-exception:').length, 1);
  assert.equal(reasons('gh pr review $PR --approve\n# reviewed-exception: release bot').length, 1);
});

test('skips comments and ordinary review references', () => {
  assert.deepEqual(
    reasons('# gh pr review $PR --approve\n// pulls.createReview({})\nreview: approved'),
    [],
  );
});

test('scans composite action content', () => {
  const hits = scanContent(
    'runs:\n  using: composite\n  steps:\n    - run: gh pr review $PR --approve\n      shell: bash\n',
    '.github/actions/review/action.yml',
  );
  assert.deepEqual(
    hits.map(({ line, filePath }) => [line, filePath]),
    [[4, '.github/actions/review/action.yml']],
  );
});

test('real CI and security workflows have no findings', () => {
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/security.yml']) {
    assert.deepEqual(scanContent(readFileSync(path, 'utf8'), path), []);
  }
});

test('CLI scans nested workflows and composite actions and reports annotations', () => {
  const root = mkdtempSync(join(tmpdir(), 'approve-review-guard-'));
  try {
    mkdirSync(join(root, '.github/workflows/nested'), { recursive: true });
    mkdirSync(join(root, '.github/actions/review'), { recursive: true });
    mkdirSync(join(root, '.github/scripts'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/nested/review.yaml'),
      'name: Test\nrun: gh pr review $PR --approve\n',
    );
    writeFileSync(
      join(root, '.github/actions/review/action.yml'),
      'runs:\n  using: composite\n  steps:\n    - uses: hmarr/auto-approve-action@abc\n',
    );
    writeFileSync(join(root, '.github/scripts/ignored.mjs'), 'gh pr review $PR --approve');
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error file=\.github\/workflows\/nested\/review\.yaml,line=2::/);
    assert.match(result.stdout, /::error file=\.github\/actions\/review\/action\.yml,line=4::/);
    assert.doesNotMatch(result.stdout, /ignored\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI runs through a symlink to the scanner', () => {
  const root = mkdtempSync(join(tmpdir(), 'approve-review-symlink-'));
  try {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/review.yml'),
      'run: gh pr review "$PR" --approve\n',
    );
    const linkedScript = join(root, 'scanner.mjs');
    symlinkSync(script, linkedScript);
    const result = spawnSync(process.execPath, [linkedScript], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error file=\.github\/workflows\/review\.yml,line=1::/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runMockAudit(mockEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'approve-review-audit-'));
  try {
    const gh = join(root, 'gh');
    writeFileSync(
      gh,
      `#!/bin/sh
case "$*" in
  "auth status") exit 0 ;;
  "auth status -t")
    if [ "$MOCK_HINT_ADMIN" = 1 ]; then
      echo 'Inactive account scopes: admin:org'
    else
      echo 'Active account scopes: repo, read:org'
    fi ;;
  *"orgs/TestSprite/repos?"*) echo 'TestSprite/example' ;;
  *"orgs/TestSprite/actions/permissions/workflow"*)
    if [ "$MOCK_ORG_READ" = 1 ]; then echo true
    else echo 'HTTP 403: Forbidden' >&2; exit 1
    fi ;;
  *"repos/TestSprite/example/actions/permissions/workflow"*) echo true ;;
  *"contents/.github/workflows/review.yml"*)
    if [ "$MOCK_REVIEW" = 1 ]; then
      printf 'run: gh pr review $PR --approve' | base64
    else
      printf 'name: Clean' | base64
    fi ;;
  *"contents/.github/workflows"*) printf 'file\\t.github/workflows/review.yml\\n' ;;
  *"contents/.github/actions"*) echo 'HTTP 404: Not Found' >&2; exit 1 ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`,
      { mode: 0o755 },
    );
    return spawnSync('bash', [auditScript], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, ...mockEnv },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('org audit keeps scanning when org policy cannot be read', { skip: publicSnapshot }, () => {
  const clean = runMockAudit({ MOCK_HINT_ADMIN: '1' });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /org can_approve_pull_request_reviews: could not be read/);
  assert.match(
    clean.stdout,
    /1 active repositories, 1 with scanned files, 1 workflows, 0 composite actions, 0 findings/,
  );

  const finding = runMockAudit({ MOCK_HINT_ADMIN: '1', MOCK_REVIEW: '1' });
  assert.equal(finding.status, 1, finding.stderr);
  assert.match(
    finding.stdout,
    /::error file=TestSprite\/example\/\.github\/workflows\/review\.yml,line=1::/,
  );
  assert.match(finding.stdout, /1 findings/);
});

test('org audit reads org policy when the API allows it', { skip: publicSnapshot }, () => {
  const result = runMockAudit({ MOCK_ORG_READ: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /org can_approve_pull_request_reviews: true/);
});
