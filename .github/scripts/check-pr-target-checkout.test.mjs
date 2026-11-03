import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  scanContent,
  scanWorkflows,
  triggersOnPullRequestTarget,
} from './check-pr-target-checkout.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const checkoutStep = `    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
`;

test('flags a checkout in a block-form pull_request_target workflow', () => {
  const content = `on:\n  pull_request_target:\n    types: [closed]\njobs:\n  notify:\n${checkoutStep}`;
  assert.deepEqual(scanContent(content, 'w.yml'), [{ filePath: 'w.yml', line: 7 }]);
});

test('flags inline and list trigger forms', () => {
  assert.equal(triggersOnPullRequestTarget('on: pull_request_target\n'), true);
  assert.equal(triggersOnPullRequestTarget('on: [push, pull_request_target]\n'), true);
  assert.equal(triggersOnPullRequestTarget('on:\n  - issues\n  - pull_request_target\n'), true);
  assert.equal(triggersOnPullRequestTarget('"on":\n  pull_request_target:\n'), true);
});

test('ignores checkouts in workflows on other triggers', () => {
  const content = `on:\n  pull_request:\n  push:\n    branches: [dev]\njobs:\n  ci:\n${checkoutStep}`;
  assert.deepEqual(scanContent(content, 'ci.yml'), []);
});

test('ignores pull_request_target mentioned outside the trigger block', () => {
  const content = `# unlike a pull_request_target workflow, this one checks out code\non:\n  pull_request:\njobs:\n  ci:\n    # pull_request_target would be unsafe here\n${checkoutStep}`;
  assert.equal(triggersOnPullRequestTarget(content), false);
  assert.deepEqual(scanContent(content, 'ci.yml'), []);
});

test('ignores a commented-out checkout and a trigger comment inside the on: block', () => {
  const content = `on:\n  pull_request_target: # metadata only\njobs:\n  notify:\n    steps:\n      # - uses: actions/checkout@v7\n      - run: echo ok\n`;
  assert.deepEqual(scanContent(content, 'w.yml'), []);
});

test('handles CRLF input', () => {
  const content = `on:\r\n  pull_request_target:\r\njobs:\r\n  x:\r\n${checkoutStep.replace(/\n/g, '\r\n')}`;
  assert.deepEqual(scanContent(content, 'w.yml'), [{ filePath: 'w.yml', line: 6 }]);
});

test("this repository's own workflows pass", () => {
  assert.deepEqual(scanWorkflows(repoRoot), []);
});
