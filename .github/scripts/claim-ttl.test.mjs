import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from './claim-ttl.mjs';

const NOW = new Date('2026-09-30T00:00:00Z');
const SINCE = '2026-09-24T00:00:00Z';
const assignedAt = hours => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
const claim = (login = 'contributor', hours = 96) => ({
  event: 'assigned',
  assignee: { login },
  created_at: assignedAt(hours),
});
const linkedPr = (
  login = 'contributor',
  state = 'open',
  draft = false,
  body = 'Adds the thing.\n\nCloses #42',
) => ({
  event: 'cross-referenced',
  source: { issue: { pull_request: {}, state, draft, user: { login }, body } },
});

function harness({
  issues = [{ number: 42, assignees: [{ login: 'contributor' }], labels: [] }],
  events = { 42: [claim()] },
  comments = {},
  permissions = {},
  eventErrorFor,
  commentErrorFor,
  env = {},
} = {}) {
  const calls = [];
  const warnings = [];
  const failures = [];
  const info = [];
  const records = structuredClone(issues);
  const commentStore = structuredClone(comments);
  const methods = {
    listForRepo: () => {},
    listEventsForTimeline: () => {},
    listComments: () => {},
    removeAssignees: async args => {
      calls.push(['removeAssignees', args]);
      const issue = records.find(item => item.number === args.issue_number);
      issue.assignees = issue.assignees.filter(user => !args.assignees.includes(user.login));
      return { data: { assignees: issue.assignees } };
    },
    createComment: async args => {
      calls.push(['createComment', args]);
      if (args.issue_number === commentErrorFor) throw new Error('comment unavailable');
      (commentStore[args.issue_number] ??= []).push({ body: args.body });
    },
    removeLabel: async args => calls.push(['removeLabel', args]),
  };
  const github = {
    rest: {
      issues: methods,
      repos: {
        getCollaboratorPermissionLevel: async ({ username }) => {
          calls.push(['permission', username]);
          if (permissions[username] instanceof Error) throw permissions[username];
          return { data: { permission: permissions[username] ?? 'read' } };
        },
      },
    },
    paginate: async (method, args) => {
      calls.push(['paginate', method, args]);
      if (method === methods.listForRepo) return records;
      if (method === methods.listEventsForTimeline) {
        if (args.issue_number === eventErrorFor) throw new Error('timeline unavailable');
        return events[args.issue_number] ?? [];
      }
      if (method === methods.listComments) return commentStore[args.issue_number] ?? [];
      throw new Error('unexpected pagination method');
    },
  };
  const core = {
    warning: message => warnings.push(message),
    setFailed: message => failures.push(message),
    info: message => info.push(message),
  };
  const execute = () =>
    run({
      github,
      context: { repo: { owner: 'TestSprite', repo: 'testsprite-cli' } },
      core,
      env: { CLAIM_TTL_SINCE: SINCE, ...env },
      now: NOW,
    });
  const writes = () =>
    calls.filter(([method]) =>
      ['removeAssignees', 'createComment', 'removeLabel'].includes(method),
    );
  const of = method => calls.filter(([name]) => name === method).map(([, args]) => args);
  return { execute, writes, of, warnings, failures, info, records, commentStore, calls };
}

test('an assignment younger than 72 hours is left alone', async () => {
  const h = harness({ events: { 42: [claim('contributor', 71.99)] } });
  await h.execute();
  assert.deepEqual(h.writes(), []);
  assert.equal(h.failures.length, 0);
});

test('warning starts at 72 hours and is posted only once for the same assignment', async () => {
  const h = harness({ events: { 42: [claim('contributor', 72)] } });
  await h.execute();
  await h.execute();
  assert.equal(h.of('createComment').length, 1);
  assert.match(h.of('createComment')[0].body, /@contributor/);
  assert.match(h.of('createComment')[0].body, /about 24 hours/);
  assert.match(h.of('createComment')[0].body, /Closes #42/);
  assert.match(h.of('createComment')[0].body, /Part of #42/);
  assert.match(h.of('createComment')[0].body, /\/assign/);
  assert.match(
    h.of('createComment')[0].body,
    /<!-- claim-ttl:warn:contributor:2026-09-27T00:00:00.000Z -->/,
  );
  assert.equal(h.failures.length, 0);
});

test('the latest assignment event defines the current claim', async () => {
  const h = harness({ events: { 42: [claim('contributor', 120), claim('contributor', 73)] } });
  await h.execute();
  assert.equal(h.of('removeAssignees').length, 0);
  assert.equal(h.of('createComment').length, 1);
  assert.match(
    h.of('createComment')[0].body,
    /claim-ttl:warn:contributor:2026-09-26T23:00:00.000Z/,
  );
});

test('a warning for an older assignment does not suppress this claim warning', async () => {
  const h = harness({
    events: { 42: [claim('contributor', 150), claim('contributor', 72)] },
    comments: { 42: [{ body: '<!-- claim-ttl:warn:contributor:2026-09-23T18:00:00.000Z -->' }] },
  });
  await h.execute();
  assert.equal(h.of('createComment').length, 1);
  assert.match(
    h.of('createComment')[0].body,
    /claim-ttl:warn:contributor:2026-09-27T00:00:00.000Z/,
  );
});

test('at 96 hours the assignee is removed and the issue is released', async () => {
  const h = harness();
  await h.execute();
  assert.equal(h.of('removeAssignees').length, 1);
  assert.deepEqual(h.of('removeAssignees')[0].assignees, ['contributor']);
  assert.equal(h.of('createComment').length, 1);
  assert.match(h.of('createComment')[0].body, /expired after 96 hours/);
  assert.match(h.of('createComment')[0].body, /open for others/);
  assert.match(h.of('createComment')[0].body, /\/assign/);
  assert.match(
    h.of('createComment')[0].body,
    /<!-- claim-ttl:expired:contributor:2026-09-26T00:00:00.000Z -->/,
  );
  assert.deepEqual(
    h.of('removeLabel').map(args => args.name),
    ['in-progress'],
  );
  await h.execute();
  assert.equal(h.of('createComment').length, 1);
  assert.equal(h.of('removeAssignees').length, 1);
});

test('an existing expiry marker prevents a duplicate expiry comment', async () => {
  const h = harness({
    comments: { 42: [{ body: '<!-- claim-ttl:expired:contributor:2026-09-26T00:00:00.000Z -->' }] },
  });
  await h.execute();
  assert.equal(h.of('removeAssignees').length, 1);
  assert.equal(h.of('createComment').length, 0);
});

test('expiry removes the in-progress label even if its comment fails', async () => {
  const h = harness({ commentErrorFor: 42 });
  await h.execute();
  assert.equal(h.of('removeAssignees').length, 1);
  assert.deepEqual(
    h.of('removeLabel').map(args => args.name),
    ['in-progress'],
  );
  assert.equal(h.failures.length, 1);
});

test('an open linked draft PR by the assignee keeps the claim alive', async () => {
  const h = harness({ events: { 42: [claim(), linkedPr('contributor', 'open', true)] } });
  await h.execute();
  assert.deepEqual(h.writes(), []);
});

test('the sweep requests all open assigned issues and skips pull requests', async () => {
  const h = harness({
    issues: [
      { number: 42, assignees: [{ login: 'contributor' }], labels: [] },
      { number: 43, assignees: [{ login: 'other' }], labels: [], pull_request: {} },
    ],
  });
  await h.execute();
  const [name, , listArgs] = h.calls[0];
  assert.equal(name, 'paginate');
  assert.deepEqual(listArgs, {
    owner: 'TestSprite',
    repo: 'testsprite-cli',
    state: 'open',
    assignee: '*',
    per_page: 100,
  });
  assert.deepEqual(
    h.of('removeAssignees').map(args => args.issue_number),
    [42],
  );
});

test('the PR must reference this issue with a gate keyword to protect the claim', async () => {
  for (const body of ['Part of #42', 'refs: #42', 'Related to #42', 'fixes #42 and #7']) {
    const h = harness({ events: { 42: [claim(), linkedPr('contributor', 'open', false, body)] } });
    await h.execute();
    assert.deepEqual(h.writes(), [], body);
  }
  for (const body of ['See #42 for context', 'Closes #420', 'Closes #7', '']) {
    const h = harness({ events: { 42: [claim(), linkedPr('contributor', 'open', false, body)] } });
    await h.execute();
    assert.equal(h.of('removeAssignees').length, 1, body);
  }
});

test('a linked PR without a body in the timeline is treated as linked (fail safe)', async () => {
  const h = harness({
    events: { 42: [claim(), linkedPr('contributor', 'open', false, null)] },
  });
  await h.execute();
  assert.deepEqual(h.writes(), []);
});

test('a linked PR by another author or a closed PR does not protect the claim', async () => {
  for (const event of [linkedPr('other'), linkedPr('contributor', 'closed')]) {
    const h = harness({ events: { 42: [claim(), event] } });
    await h.execute();
    assert.equal(h.of('removeAssignees').length, 1);
  }
});

test('maintainers are exempt, including cached permission lookups', async () => {
  const h = harness({
    issues: [42, 43].map(number => ({ number, assignees: [{ login: 'contributor' }], labels: [] })),
    events: { 42: [claim()], 43: [claim()] },
    permissions: { contributor: 'write' },
  });
  await h.execute();
  assert.deepEqual(h.writes(), []);
  assert.equal(h.of('permission').length, 1);
});

test('read, triage, and none permissions remain subject to expiry', async () => {
  for (const permission of ['read', 'triage', 'none']) {
    const h = harness({ permissions: { contributor: permission } });
    await h.execute();
    assert.equal(h.of('removeAssignees').length, 1);
  }
});

test('a failed permission lookup leaves the assignee assigned', async () => {
  const h = harness({ permissions: { contributor: new Error('forbidden') } });
  await h.execute();
  assert.deepEqual(h.writes(), []);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.failures.length, 0);
});

test('without an assigned event the claim is left alone', async () => {
  const h = harness({ events: { 42: [] } });
  await h.execute();
  assert.deepEqual(h.writes(), []);
});

test('claims before the configured start time are grandfathered', async () => {
  const h = harness({ events: { 42: [claim('contributor', 150)] } });
  await h.execute();
  assert.deepEqual(h.writes(), []);
});

test('pinned issues are exempt', async () => {
  const h = harness({
    issues: [{ number: 42, assignees: [{ login: 'contributor' }], labels: [{ name: 'pinned' }] }],
  });
  await h.execute();
  assert.deepEqual(h.writes(), []);
});

test('a pinned label returned as a string is also exempt', async () => {
  const h = harness({
    issues: [{ number: 42, assignees: [{ login: 'contributor' }], labels: ['pinned'] }],
  });
  await h.execute();
  assert.deepEqual(h.writes(), []);
});

test('dry run reads and logs but makes no writes', async () => {
  const h = harness({ env: { DRY_RUN: 'true' } });
  await h.execute();
  assert.deepEqual(h.writes(), []);
  assert.ok(h.calls.some(([method]) => method === 'paginate'));
  assert.ok(h.info.some(message => message.includes('would expire')));

  const warning = harness({
    events: { 42: [claim('contributor', 72)] },
    env: { DRY_RUN: 'true' },
  });
  await warning.execute();
  assert.deepEqual(warning.writes(), []);
  assert.ok(warning.info.some(message => message.includes('would warn')));
});

test('one bad issue does not stop processing another issue', async () => {
  const h = harness({
    issues: [42, 43].map(number => ({ number, assignees: [{ login: 'contributor' }], labels: [] })),
    events: { 43: [claim()] },
    eventErrorFor: 42,
  });
  await h.execute();
  assert.deepEqual(
    h.of('removeAssignees').map(args => args.issue_number),
    [43],
  );
  assert.equal(h.warnings.length, 1);
  assert.equal(h.failures.length, 0);
});

test('when every scanned issue errors the sweep fails', async () => {
  const h = harness({ eventErrorFor: 42 });
  await h.execute();
  assert.equal(h.failures.length, 1);
});

test('two assignees are evaluated independently and the label stays while one remains', async () => {
  const h = harness({
    issues: [{ number: 42, assignees: [{ login: 'contributor' }, { login: 'other' }], labels: [] }],
    events: { 42: [claim(), claim('other', 20)] },
  });
  await h.execute();
  assert.deepEqual(
    h.of('removeAssignees').map(args => args.assignees),
    [['contributor']],
  );
  assert.deepEqual(h.records[0].assignees, [{ login: 'other' }]);
  assert.equal(h.of('removeLabel').length, 0);
});

test('invalid TTL settings fail before any writes', async () => {
  for (const env of [
    { CLAIM_TTL_HOURS: '0' },
    { CLAIM_WARN_HOURS: '-1' },
    { CLAIM_WARN_HOURS: '96' },
  ]) {
    const h = harness({ env });
    await h.execute();
    assert.deepEqual(h.writes(), []);
    assert.equal(h.failures.length, 1);
  }
});

test('scheduled workflow pins the policy and runs only in the public repo', () => {
  const path = fileURLToPath(new URL('../workflows/claim-ttl.yml', import.meta.url));
  const workflow = readFileSync(path, 'utf8');
  assert.match(workflow, /^ {4}if: github\.repository == 'TestSprite\/testsprite-cli'$/m);
  assert.match(workflow, /^ {2}CLAIM_TTL_HOURS: '96'$/m);
  assert.match(workflow, /^ {2}CLAIM_WARN_HOURS: '72'$/m);
  assert.match(workflow, /^ {2}CLAIM_TTL_SINCE: '2026-09-24T00:00:00Z'$/m);
  assert.match(
    workflow,
    /^ {2}DRY_RUN: \$\{\{ inputs\.dry_run == true && 'true' \|\| 'false' \}\}$/m,
  );
});
