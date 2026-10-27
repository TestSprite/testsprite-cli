import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const workflowPath = fileURLToPath(new URL('../workflows/bonus-entry.yml', import.meta.url));
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
const runScript = new AsyncFunction('github', 'context', 'core', script);

const templatePath = fileURLToPath(new URL('../PULL_REQUEST_TEMPLATE.md', import.meta.url));
const template = readFileSync(templatePath, 'utf8');
const TICKED = "- [x] I'm entering this PR for the Season 4 CLI Improvement Bonus";
const UNTICKED = "- [ ] I'm entering this PR for the Season 4 CLI Improvement Bonus";
const MARKER = '<!-- hob:s4-bonus -->';
const LABEL = 's4-cli-bonus';

async function runPr({
  body = `Closes #42\n\n${TICKED}\n\nDiscord username: contributor#1234`,
  title = 'fix(cli): a real fix',
  draft = false,
  labels = [],
  comments = [],
  // Issues the GraphQL closing-reference query returns.
  closing = [{ number: 42, title: 'Some bug', labels: [], assignees: ['contributor'] }],
  // Issues reachable through issues.get for body-only references.
  issues = {},
  labelExists = true,
  closesAt = '2999-01-01T00:00:00Z',
  state = 'open',
  // The event payload; defaults to the live PR. A queued run can carry an older one.
  payload,
  // A workflow_dispatch sweep: no PR in the payload, these open PRs listed instead.
  sweep,
  // PR numbers whose pulls.get throws during a sweep.
  failOn = [],
} = {}) {
  const calls = [];
  const info = [];
  const failures = [];
  const livePr = {
    number: 7,
    state,
    title,
    body,
    draft,
    labels: labels.map(name => ({ name })),
    user: { login: 'contributor' },
  };
  const rest = {
    pulls: {
      get: async ({ pull_number }) => {
        if (sweep) {
          if (failOn.includes(pull_number)) throw Object.assign(new Error('boom'), { status: 500 });
          return { data: { ...structuredClone(livePr), number: pull_number } };
        }
        assert.equal(pull_number, 7);
        return { data: structuredClone(livePr) };
      },
      list: () => {},
    },
    issues: {
      get: async ({ issue_number }) => {
        if (!issues[issue_number]) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: issues[issue_number] };
      },
      listComments: () => {},
      createComment: async args => calls.push(['createComment', args]),
      updateComment: async args => calls.push(['updateComment', args]),
      addLabels: async args => calls.push(['addLabels', args]),
      removeLabel: async args => calls.push(['removeLabel', args]),
      createLabel: async args => calls.push(['createLabel', args]),
      getLabel: async () => {
        if (!labelExists) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: { name: LABEL } };
      },
    },
  };
  const github = {
    rest,
    paginate: async method => {
      if (method === rest.pulls.list) return sweep;
      assert.equal(method, rest.issues.listComments);
      return comments;
    },
    graphql: async () => ({
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: closing.map(i => ({
              number: i.number,
              title: i.title,
              labels: { nodes: i.labels.map(name => ({ name })) },
              assignees: { nodes: i.assignees.map(login => ({ login })) },
            })),
          },
        },
      },
    }),
  };
  const context = {
    repo: { owner: 'TestSprite', repo: 'testsprite-cli' },
    payload: sweep ? {} : { pull_request: payload ?? livePr },
  };
  const warnings = [];
  const core = {
    info: message => info.push(message),
    warning: message => warnings.push(message),
    setFailed: message => failures.push(message),
  };
  const saved = {};
  const env = { LABEL, MARKER, BONUS_CLOSES_AT: closesAt, APP_TOKEN: '' };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await runScript(github, context, core);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const of = name => calls.filter(([method]) => method === name).map(([, args]) => args);
  return { calls, of, info, failures, warnings };
}

const stateOf = body => /<!-- hob:s4-bonus:state:(\w+) -->/.exec(body)?.[1];
const botComment = body => ({ id: 99, user: { login: 'github-actions[bot]' }, body });

test('a ticked box records the entry, labels the PR and confirms in one comment', async () => {
  const h = await runPr();
  const [comment] = h.of('createComment');
  assert.equal(h.of('createComment').length, 1);
  assert.equal(comment.issue_number, 7);
  assert.ok(comment.body.startsWith(MARKER));
  assert.equal(stateOf(comment.body), 'entered');
  assert.match(comment.body, /entry recorded/);
  assert.match(comment.body, /@contributor/);
  assert.match(comment.body, /✅ A linked issue assigned to you\./);
  assert.match(comment.body, /✅ Out of draft\./);
  assert.match(comment.body, /✅ A Discord username/);
  assert.match(comment.body, /Oct 29, 11:59 PM PT/);
  assert.deepEqual(h.of('addLabels'), [
    { owner: 'TestSprite', repo: 'testsprite-cli', issue_number: 7, labels: [LABEL] },
  ]);
  assert.equal(h.of('createLabel').length, 0);
  assert.equal(h.failures.length, 0);
});

test('the template checkbox, once ticked, is what the bot recognises', async () => {
  assert.ok(template.includes(UNTICKED), 'template must carry the entry checkbox');
  assert.match(template, /^Discord username:$/m);
  const h = await runPr({ body: template.replace(UNTICKED, TICKED) });
  assert.equal(stateOf(h.of('createComment')[0].body), 'entered');
  assert.equal(h.of('addLabels').length, 1);
});

test('the untouched template is not an entry and not a near-miss', async () => {
  const h = await runPr({ body: template });
  assert.deepEqual(h.calls, []);
});

test('an entry lists what is still missing: draft, unclaimed issue, Discord', async () => {
  const h = await runPr({
    body: TICKED,
    draft: true,
    closing: [{ number: 42, title: 'Some bug', labels: [], assignees: ['someone-else'] }],
  });
  const body = h.of('createComment')[0].body;
  assert.equal(stateOf(body), 'entered');
  assert.match(body, /⬜ A linked issue assigned to you: the issue this PR links isn't assigned/);
  assert.match(body, /`\/assign`/);
  assert.match(body, /⬜ Out of draft: this PR is still a draft/);
  assert.match(body, /No Discord username/);
  assert.match(body, /reach you here on the PR/);
});

test('an entry without any linked issue says how to link one', async () => {
  const h = await runPr({ body: TICKED, closing: [] });
  assert.match(h.of('createComment')[0].body, /add `Closes #123`/);
});

test('a body-only "Part of #N" reference counts as the linked issue', async () => {
  const h = await runPr({
    body: `Part of #50\n\n${TICKED}`,
    closing: [],
    issues: { 50: { title: 'Umbrella', labels: [], assignees: [{ login: 'contributor' }] } },
  });
  assert.match(h.of('createComment')[0].body, /✅ A linked issue assigned to you\./);
});

test('box variants: capital X, other list markers, a typographic apostrophe', async () => {
  for (const line of [
    "- [X] I'm entering this PR for the Season 4 CLI Improvement Bonus",
    "* [x] I'm entering this PR for the Season 4 CLI Improvement Bonus",
    '  + [x] I’m entering this PR for the Season 4 CLI Improvement Bonus',
  ]) {
    const h = await runPr({ body: line });
    assert.equal(stateOf(h.of('createComment')[0]?.body ?? ''), 'entered', line);
  }
});

test('a ticked box inside an HTML comment is not an entry', async () => {
  const h = await runPr({ body: `<!--\n${TICKED}\n-->` });
  assert.deepEqual(h.calls, []);
});

test('an unticked [Hackathon] PR is asked, not labelled', async () => {
  const h = await runPr({ body: UNTICKED, title: '[Hackathon] fix: something' });
  const body = h.of('createComment')[0].body;
  assert.equal(stateOf(body), 'maybe');
  assert.match(body, /entry box in the description isn't ticked/);
  assert.ok(body.includes(TICKED), 'shows the ticked line to paste');
  assert.equal(h.of('addLabels').length, 0);
});

test('an unticked PR linking a hackathon issue is asked', async () => {
  for (const issue of [
    { number: 42, title: 'Some bug', labels: ['hackathon'], assignees: ['contributor'] },
    { number: 42, title: '[Hackathon] Some bug', labels: [], assignees: ['contributor'] },
  ]) {
    const h = await runPr({ body: 'Closes #42', closing: [issue] });
    assert.equal(stateOf(h.of('createComment')[0].body), 'maybe');
  }
});

test('an unticked PR with a Discord username filled in is asked', async () => {
  const h = await runPr({ body: `${UNTICKED}\n\nDiscord username: someone` });
  assert.equal(stateOf(h.of('createComment')[0].body), 'maybe');
});

test('placeholder Discord values do not count as a username', async () => {
  for (const value of ['', '<your username>', 'N/A', '-', 'none']) {
    const h = await runPr({ body: `${UNTICKED}\n\nDiscord username: ${value}` });
    assert.deepEqual(h.calls, [], JSON.stringify(value));
  }
});

test('unticking a recorded entry records the withdrawal and removes the label', async () => {
  const first = await runPr();
  const sticky = botComment(first.of('createComment')[0].body);
  const h = await runPr({ body: UNTICKED, labels: [LABEL], comments: [sticky] });
  assert.equal(h.of('createComment').length, 0);
  const [update] = h.of('updateComment');
  assert.equal(update.comment_id, 99);
  assert.equal(stateOf(update.body), 'withdrawn');
  assert.match(update.body, /no longer entered/);
  assert.deepEqual(
    h.of('removeLabel').map(args => args.name),
    [LABEL],
  );
});

test('re-running on an unchanged PR makes no writes', async () => {
  const first = await runPr();
  const sticky = botComment(first.of('createComment')[0].body);
  const h = await runPr({ labels: [LABEL], comments: [sticky] });
  assert.deepEqual(h.calls, []);
});

test('fixing a missing item updates the same comment', async () => {
  const first = await runPr({ draft: true });
  const sticky = botComment(first.of('createComment')[0].body);
  const h = await runPr({ labels: [LABEL], comments: [sticky] });
  assert.equal(h.of('createComment').length, 0);
  assert.equal(h.of('updateComment').length, 1);
  assert.match(h.of('updateComment')[0].body, /✅ Out of draft\./);
});

test('the bonus label is created when it does not exist yet', async () => {
  const h = await runPr({ labelExists: false });
  assert.equal(h.of('createLabel').length, 1);
  assert.equal(h.of('createLabel')[0].name, LABEL);
  const order = h.calls
    .map(([method]) => method)
    .filter(m => m.endsWith('Label') || m === 'addLabels');
  assert.deepEqual(order, ['createLabel', 'addLabels']);
});

test('after the close the bot changes nothing', async () => {
  const h = await runPr({ closesAt: '2000-01-01T00:00:00Z' });
  assert.deepEqual(h.calls, []);
  assert.ok(h.info.some(message => message.includes('has closed')));
});

test('an invalid close time fails without writes', async () => {
  const h = await runPr({ closesAt: 'not-a-date' });
  assert.deepEqual(h.calls, []);
  assert.equal(h.failures.length, 1);
});

test('workflow pins the close, stays metadata-only and runs only in the public repo', () => {
  assert.match(workflow, /^ {2}BONUS_CLOSES_AT: '2026-10-30T06:59:59Z'$/m);
  assert.match(workflow, /^ {2}LABEL: 's4-cli-bonus'$/m);
  assert.match(workflow, /github\.repository == 'TestSprite\/testsprite-cli'/);
  assert.match(
    workflow,
    /^ {4}types: \[opened, edited, reopened, synchronize, ready_for_review, converted_to_draft\]$/m,
  );
  assert.doesNotMatch(workflow, /actions\/checkout/);
});

test('a marker comment pasted by a user is not taken for the bot comment', async () => {
  const first = await runPr();
  const spoof = { id: 5, user: { login: 'someone' }, body: first.of('createComment')[0].body };
  const entered = await runPr({ comments: [spoof] });
  assert.equal(entered.of('updateComment').length, 0);
  assert.equal(entered.of('createComment').length, 1);
  assert.equal(entered.of('addLabels').length, 1);

  // Nor does a pasted "entered" state make an untouched PR look withdrawn.
  const untouched = await runPr({ body: UNTICKED, comments: [spoof] });
  assert.deepEqual(untouched.calls, []);
});

test('a queued run acts on the live PR, not its stale event payload', async () => {
  const first = await runPr();
  const sticky = botComment(first.of('createComment')[0].body);
  // Ticked, then unticked straight away: the second run's payload predates the
  // label the first run added, but the live PR has it.
  const stale = {
    number: 7,
    title: 'x',
    body: UNTICKED,
    draft: false,
    labels: [],
    user: { login: 'contributor' },
  };
  const withdrawn = await runPr({
    body: UNTICKED,
    labels: [LABEL],
    comments: [sticky],
    payload: stale,
  });
  assert.equal(stateOf(withdrawn.of('updateComment')[0].body), 'withdrawn');
  assert.deepEqual(
    withdrawn.of('removeLabel').map(args => args.name),
    [LABEL],
  );

  // And the reverse: a payload that is still unticked while the live PR is ticked.
  const reentered = await runPr({ payload: { ...stale, body: UNTICKED } });
  assert.equal(stateOf(reentered.of('createComment')[0].body), 'entered');
  assert.equal(reentered.of('addLabels').length, 1);
});

test('a PR closed before its queued run gets no writes', async () => {
  const h = await runPr({ state: 'closed' });
  assert.deepEqual(h.calls, []);
});

test('unticking keeps the withdrawal even when the PR still looks like an entry', async () => {
  const first = await runPr();
  const entered = botComment(first.of('createComment')[0].body);
  // The default body keeps its Discord username, which alone reads as a near miss.
  const untickedBody = `Closes #42\n\n${UNTICKED}\n\nDiscord username: contributor#1234`;
  const h = await runPr({ body: untickedBody, labels: [LABEL], comments: [entered] });
  const withdrawn = h.of('updateComment')[0].body;
  assert.equal(stateOf(withdrawn), 'withdrawn');
  assert.deepEqual(
    h.of('removeLabel').map(args => args.name),
    [LABEL],
  );

  // A later edit that is still unticked leaves the withdrawal as it is.
  const again = await runPr({ body: untickedBody, comments: [botComment(withdrawn)] });
  assert.deepEqual(again.calls, []);
});

test('the job token may write to PRs: a PR comment needs pull-requests write', () => {
  assert.match(workflow, /^ {2}pull-requests: write$/m);
  assert.match(workflow, /^ {2}issues: write /m);
});

test('a manual run sweeps every open PR not opened by a bot', async () => {
  const h = await runPr({
    sweep: [
      { number: 11, user: { type: 'User' } },
      { number: 12, user: { type: 'Bot' } },
      { number: 13, user: { type: 'User' } },
    ],
  });
  assert.deepEqual(
    h.of('createComment').map(args => args.issue_number),
    [11, 13],
  );
  assert.deepEqual(
    h.of('addLabels').map(args => args.issue_number),
    [11, 13],
  );
  assert.equal(h.failures.length, 0);
});

test('a sweep keeps going past a failing PR and fails the run at the end', async () => {
  const h = await runPr({
    sweep: [
      { number: 11, user: { type: 'User' } },
      { number: 12, user: { type: 'User' } },
      { number: 13, user: { type: 'User' } },
    ],
    failOn: [12],
  });
  assert.deepEqual(
    h.of('createComment').map(args => args.issue_number),
    [11, 13],
  );
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /PR #12/);
  assert.deepEqual(h.failures, ['Bonus entry sweep failed for: #12']);
});

test('a sweep is gated like a PR event and serialised on its own group', () => {
  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' \|\|/);
  assert.match(
    workflow,
    /group: bonus-entry-\$\{\{ github\.event\.pull_request\.number \|\| 'sweep' \}\}/,
  );
});
