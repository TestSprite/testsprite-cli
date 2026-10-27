import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const workflowPath = fileURLToPath(new URL('../workflows/issue-label.yml', import.meta.url));
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

// Returns the labels the script asked for, or null when it added none.
async function runIssue({ title = 'something broke', labels = [] } = {}) {
  const calls = [];
  const github = {
    rest: { issues: { addLabels: async args => calls.push(args) } },
  };
  const context = {
    repo: { owner: 'TestSprite', repo: 'testsprite-cli' },
    payload: { issue: { number: 50, title, labels } },
  };
  await runScript(github, context);
  assert.ok(calls.length <= 1, 'the script should label an issue at most once');
  if (calls.length === 0) return null;
  assert.equal(calls[0].owner, 'TestSprite');
  assert.equal(calls[0].repo, 'testsprite-cli');
  assert.equal(calls[0].issue_number, 50);
  return calls[0].labels;
}

test('an API-created hackathon issue gets both labels', async () => {
  const labels = await runIssue({ title: '[Hackathon] fix(report): JUnit names collapse' });
  assert.deepEqual(labels, ['needs-triage', 'hackathon']);
});

test('an API-created issue with no recognised prefix still reaches the queue', async () => {
  const labels = await runIssue({ title: 'test lint does not warn on conditional assertions' });
  assert.deepEqual(labels, ['needs-triage']);
});

test('an issue that already carries labels is left alone', async () => {
  const labels = await runIssue({
    title: '[Hackathon] opened through the web form',
    labels: [{ name: 'hackathon' }, { name: 'needs-triage' }],
  });
  assert.equal(labels, null);
});

test('a single pre-existing label is enough to skip', async () => {
  assert.equal(await runIssue({ title: 'anything', labels: [{ name: 'bug' }] }), null);
});

test('the hackathon prefix is matched case-insensitively', async () => {
  for (const title of ['[hackathon] lower', '[HACKATHON] upper', '[HaCkAtHoN] mixed']) {
    assert.deepEqual(await runIssue({ title }), ['needs-triage', 'hackathon'], title);
  }
});

test('leading whitespace before the prefix is tolerated', async () => {
  assert.deepEqual(await runIssue({ title: '   [Hackathon] padded' }), [
    'needs-triage',
    'hackathon',
  ]);
});

test('the prefix only counts at the start of the title', async () => {
  assert.deepEqual(await runIssue({ title: 'a [Hackathon] mention mid-title' }), ['needs-triage']);
  assert.deepEqual(await runIssue({ title: 'fix: see [hackathon] thread' }), ['needs-triage']);
});

test('a missing title or labels array does not throw', async () => {
  assert.deepEqual(await runIssue({ title: undefined }), ['needs-triage']);
  assert.deepEqual(await runIssue({ title: '[Hackathon] x', labels: undefined }), [
    'needs-triage',
    'hackathon',
  ]);
});
