import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const workflowPath = fileURLToPath(new URL('../workflows/issue-triage.yml', import.meta.url));
const lines = readFileSync(workflowPath, 'utf8').split('\n');
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

async function runComment({
  labels = [],
  association = 'NONE',
  assigned = [],
  body = '/assign',
  enforce = false,
  // Repository permission returned for the commenter; 'error' makes the lookup throw.
  permission = 'read',
} = {}) {
  const calls = [];
  const issues = {
    addAssignees: async args => calls.push(['addAssignees', args]),
    addLabels: async args => calls.push(['addLabels', args]),
    createComment: async args => calls.push(['createComment', args]),
    removeAssignees: async args => {
      calls.push(['removeAssignees', args]);
      return { data: { assignees: [] } };
    },
    removeLabel: async args => calls.push(['removeLabel', args]),
    listForRepo: () => {},
  };
  const repos = {
    getCollaboratorPermissionLevel: async () => {
      if (permission === 'error') throw new Error('permission lookup failed');
      return { data: { permission } };
    },
  };
  const github = { paginate: async () => assigned, rest: { issues, repos } };
  const context = {
    repo: { owner: 'TestSprite', repo: 'testsprite-cli' },
    payload: {
      issue: { number: 42, labels: labels.map(name => ({ name })) },
      comment: { body, author_association: association, user: { login: 'contributor' } },
    },
  };
  const previousCap = process.env.SLOT_CAP;
  const previousEnforce = process.env.ENFORCE_CAP;
  process.env.SLOT_CAP = '3';
  process.env.ENFORCE_CAP = String(enforce);
  try {
    await runScript(github, context);
  } finally {
    if (previousCap === undefined) delete process.env.SLOT_CAP;
    else process.env.SLOT_CAP = previousCap;
    if (previousEnforce === undefined) delete process.env.ENFORCE_CAP;
    else process.env.ENFORCE_CAP = previousEnforce;
  }
  return calls;
}

function callsOf(calls, name) {
  return calls.filter(([method]) => method === name).map(([, args]) => args);
}

test('issue claims require triage acceptance while existing claims remain usable', async () => {
  for (const labels of [[], ['needs-triage']]) {
    const calls = await runComment({
      labels,
      enforce: true,
      assigned: [1, 2, 3].map(number => ({ number, title: 'Other issue' })),
    });
    assert.equal(callsOf(calls, 'addAssignees').length, 0);
    assert.equal(callsOf(calls, 'addLabels').length, 0);
    const replies = callsOf(calls, 'createComment');
    assert.equal(replies.length, 1);
    assert.match(replies[0].body, /hasn't been accepted for implementation yet/);
    assert.doesNotMatch(replies[0].body, /issue limit|Assigned to/);
  }

  for (const label of ['accepted', 'good first issue', 'help wanted']) {
    const calls = await runComment({ labels: [label] });
    assert.equal(callsOf(calls, 'addAssignees').length, 1);
    assert.match(
      callsOf(calls, 'createComment')[0].body,
      /Assigned to @contributor.*2 more slots available/,
    );
  }

  // If the permission lookup fails, the payload association is the fallback.
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    const calls = await runComment({ association, permission: 'error' });
    assert.equal(callsOf(calls, 'addAssignees').length, 1);
    assert.match(callsOf(calls, 'createComment')[0].body, /Assigned to @contributor/);
  }

  const existing = await runComment({ assigned: [{ number: 42, title: 'Claimed issue' }] });
  assert.equal(callsOf(existing, 'addAssignees').length, 0);
  assert.match(callsOf(existing, 'createComment')[0].body, /Assigned to @contributor/);

  const unassign = await runComment({ body: '/unassign' });
  assert.equal(callsOf(unassign, 'removeAssignees').length, 1);
  assert.match(callsOf(unassign, 'createComment')[0].body, /Unassigned @contributor/);
});

test('the enforced cap refuses a fourth accepted claim from a non-maintainer', async () => {
  assert.match(readFileSync(workflowPath, 'utf8'), /^ {2}ENFORCE_CAP: 'true'$/m);
  const calls = await runComment({
    labels: ['accepted'],
    enforce: true,
    assigned: [1, 2, 3].map(number => ({ number, title: 'Claimed issue' })),
  });
  assert.equal(callsOf(calls, 'addAssignees').length, 0);
  assert.equal(callsOf(calls, 'addLabels').length, 0);
  assert.match(callsOf(calls, 'createComment')[0].body, /at the 3-issue limit/);
});

test('maintainers are recognised by repository permission, not only by association', async () => {
  // A maintainer with private org membership arrives as CONTRIBUTOR.
  for (const permission of ['write', 'maintain', 'admin']) {
    const calls = await runComment({ association: 'CONTRIBUTOR', permission });
    assert.equal(callsOf(calls, 'addAssignees').length, 1);
  }
  for (const permission of ['read', 'triage']) {
    const calls = await runComment({ association: 'CONTRIBUTOR', permission });
    assert.equal(callsOf(calls, 'addAssignees').length, 0);
    assert.match(callsOf(calls, 'createComment')[0].body, /hasn't been accepted/);
  }
  const fallback = await runComment({ association: 'CONTRIBUTOR', permission: 'error' });
  assert.equal(callsOf(fallback, 'addAssignees').length, 0);
});

test('the enforced cap does not apply to maintainers', async () => {
  const calls = await runComment({
    enforce: true,
    permission: 'write',
    assigned: [1, 2, 3].map(number => ({ number, title: 'Claimed issue' })),
  });
  assert.equal(callsOf(calls, 'addAssignees').length, 1);
  assert.doesNotMatch(callsOf(calls, 'createComment')[0].body, /at the 3-issue limit/);
});
