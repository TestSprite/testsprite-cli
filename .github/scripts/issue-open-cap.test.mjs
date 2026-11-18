import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const workflowPath = fileURLToPath(new URL('../workflows/issue-open-cap.yml', import.meta.url));
const workflow = readFileSync(workflowPath, 'utf8');
const lines = workflow.split('\n');
const scriptStart = lines.indexOf('          script: |');
assert.notEqual(scriptStart, -1);
const script = lines
  .slice(scriptStart + 1)
  .map(line => {
    if (line.length === 0) return '';
    assert.ok(line.startsWith('            '));
    return line.slice(12);
  })
  .join('\n');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const runScript = new AsyncFunction('github', 'context', script);

async function runIssue({
  // Open items the author created, as listForRepo returns them (PRs included).
  open = [],
  action = 'opened',
  sender = 'contributor',
  permission = 'read',
  association = 'NONE',
} = {}) {
  const calls = [];
  const issues = {
    listForRepo: () => {},
    createComment: async args => calls.push(['createComment', args]),
    update: async args => calls.push(['update', args]),
  };
  const repos = {
    getCollaboratorPermissionLevel: async () => {
      if (permission === 'error') throw new Error('permission lookup failed');
      return { data: { permission } };
    },
  };
  const github = {
    paginate: async (method, params) => {
      assert.equal(method, issues.listForRepo);
      assert.equal(params.creator, 'contributor');
      assert.equal(params.state, 'open');
      return open;
    },
    rest: { issues, repos },
  };
  const context = {
    repo: { owner: 'TestSprite', repo: 'testsprite-cli' },
    payload: {
      action,
      sender: { login: sender },
      issue: { number: 50, user: { login: 'contributor' }, author_association: association },
    },
  };
  const previous = process.env.OPEN_CAP;
  process.env.OPEN_CAP = '3';
  try {
    await runScript(github, context);
  } finally {
    if (previous === undefined) delete process.env.OPEN_CAP;
    else process.env.OPEN_CAP = previous;
  }
  return name => calls.filter(([method]) => method === name).map(([, args]) => args);
}

const issueItems = numbers => numbers.map(number => ({ number, title: `Issue ${number}` }));

test('the cap is three open issues', () => {
  assert.match(workflow, /^ {2}OPEN_CAP: '3'$/m);
});

test('a fourth open issue is closed with a comment listing the other three', async () => {
  const of = await runIssue({ open: issueItems([11, 12, 13, 50]) });
  const [comment] = of('createComment');
  assert.equal(comment.issue_number, 50);
  assert.match(comment.body, /at most 3 open at a time/);
  assert.match(comment.body, /#11 — Issue 11/);
  assert.doesNotMatch(comment.body, /#50/);
  assert.deepEqual(of('update'), [
    {
      owner: 'TestSprite',
      repo: 'testsprite-cli',
      issue_number: 50,
      state: 'closed',
      state_reason: 'not_planned',
    },
  ]);
});

test('up to three open issues, and PRs, are left alone', async () => {
  const of = await runIssue({
    open: [...issueItems([11, 12, 50]), { number: 14, pull_request: {} }],
  });
  assert.equal(of('createComment').length, 0);
  assert.equal(of('update').length, 0);
});

test('an issue claimed by someone else does not count, one claimed by the author does', async () => {
  const claimedByOther = { number: 13, title: 'Issue 13', assignees: [{ login: 'someone-else' }] };
  const claimedBySelf = { number: 14, title: 'Issue 14', assignees: [{ login: 'contributor' }] };
  const under = await runIssue({ open: [...issueItems([11, 12]), claimedByOther] });
  assert.equal(under('update').length, 0);
  const over = await runIssue({ open: [...issueItems([11, 12]), claimedBySelf] });
  assert.equal(over('update').length, 1);
  assert.match(over('createComment')[0].body, /#14 — Issue 14/);
});

test('maintainers are exempt, by permission or by association when the lookup fails', async () => {
  for (const permission of ['write', 'maintain', 'admin']) {
    const of = await runIssue({ open: issueItems([11, 12, 13]), permission });
    assert.equal(of('update').length, 0);
  }
  const fallback = await runIssue({
    open: issueItems([11, 12, 13]),
    permission: 'error',
    association: 'MEMBER',
  });
  assert.equal(fallback('update').length, 0);
  const community = await runIssue({ open: issueItems([11, 12, 13]), permission: 'error' });
  assert.equal(community('update').length, 1);
});

test('reopening over the cap closes again, unless a maintainer reopened it', async () => {
  const self = await runIssue({ open: issueItems([11, 12, 13]), action: 'reopened' });
  assert.equal(self('update').length, 1);
  const byMaintainer = await runIssue({
    open: issueItems([11, 12, 13]),
    action: 'reopened',
    sender: 'maintainer',
  });
  assert.equal(byMaintainer('update').length, 0);
});

test('runs are serialised per author and skip bots', () => {
  assert.match(workflow, /group: issue-open-cap-\$\{\{ github\.event\.issue\.user\.login \}\}/);
  assert.match(workflow, /github\.event\.issue\.user\.type != 'Bot'/);
});
