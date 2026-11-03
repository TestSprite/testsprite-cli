/**
 * Fail when a workflow triggered by `pull_request_target` checks out code.
 *
 * `pull_request_target` runs with the base repository's secrets and a
 * write-capable token even for pull requests from forks. Checking out code in
 * such a workflow lets the pull request's content run next to those
 * credentials, and this repository's secrets include write-capable ones (for
 * example the deploy key the backport sweep pushes with). The
 * `pull_request_target` workflows here are metadata-only by design; this check
 * keeps them that way. A workflow that needs the pull request's code belongs
 * on `pull_request`, which gets no secrets for forks.
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOP_LEVEL_ON = /^(?:on|"on"|'on')\s*:(.*)$/;
const CHECKOUT = /^\s*(?:-\s*)?uses:\s*["']?actions\/checkout(?:@|["'\s]|$)/;

function stripComment(line) {
  const match = /(^|\s)#/.exec(line);
  return match ? line.slice(0, match.index) : line;
}

/** True when the workflow's top-level `on:` lists `pull_request_target`. */
export function triggersOnPullRequestTarget(content) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = TOP_LEVEL_ON.exec(lines[i]);
    if (!match) continue;
    if (/\bpull_request_target\b/.test(stripComment(match[1]))) return true;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\S/.test(line) && !/^#/.test(line)) break;
      if (/\bpull_request_target\b/.test(stripComment(line))) return true;
    }
    return false;
  }
  return false;
}

/** Every `uses: actions/checkout` step in a `pull_request_target` workflow. */
export function scanContent(content, filePath) {
  if (!triggersOnPullRequestTarget(content)) return [];
  const hits = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (CHECKOUT.test(stripComment(line))) hits.push({ filePath, line: index + 1 });
  }
  return hits;
}

export function scanWorkflows(root) {
  const dir = join(root, '.github', 'workflows');
  const hits = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const path = join(dir, name);
    hits.push(...scanContent(readFileSync(path, 'utf8'), relative(root, path)));
  }
  return hits;
}

function main() {
  const hits = scanWorkflows(process.cwd());
  if (hits.length === 0) {
    console.log('pull_request_target checkout guard: clean');
    return;
  }
  for (const hit of hits) {
    console.error(
      `${hit.filePath}:${hit.line}: actions/checkout in a pull_request_target workflow`,
    );
  }
  console.error(
    "A pull_request_target workflow runs with this repository's secrets even for fork PRs, so it must not check out code. Move the job to pull_request instead.",
  );
  process.exit(1);
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
) {
  main();
}
