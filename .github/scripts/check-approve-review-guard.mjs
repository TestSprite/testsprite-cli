/**
 * Find workflow steps that can submit an approving pull-request review.
 * Place `# reviewed-exception: <reason>` on the finding's line only after
 * reviewing a justified use. The marker must explain the exception.
 * This scans local workflows and composite actions, not third-party code.
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const reviewCalls = [
  [/\bpulls\.(?:createReview|submitReview)\s*\(/, 'Octokit pull review submission'],
  [/\breviews\.create\s*\(/, 'Octokit review creation'],
  [/["']?\bevent["']?\s*[:=]\s*["']?APPROVE\b/, 'APPROVE review event'],
];
const ghReview = /\bgh\s+pr\s+review\b/;
const approveFlag = /(?:^|\s)(?:--approve|-a)(?=\s|$|;)/;
const exception = /#\s*reviewed-exception:\s*\S/;
const actionUse = /^\s*(?:-\s*)?uses:\s*["']?[-\w.]+\/([-\w.]+)@/;
const approvalAction =
  /(?:auto[-_]?approve|approve[-_]?(?:pull[-_]?request|pr)|(?:pull[-_]?request|pr)[-_]?approve)/i;

export function scanContent(content, filePath) {
  const hits = [];
  let continuedReview = false;
  let continuedEvent = false;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trimStart();
    if (/^(?:#|\/\/|\*(?!\)))/.test(trimmed)) {
      continuedReview = false;
      continuedEvent = false;
      continue;
    }
    const reviewOnLine = ghReview.test(line);
    if (!exception.test(line)) {
      for (const [pattern, reason] of reviewCalls) {
        if (pattern.test(line)) hits.push({ filePath, line: index + 1, reason });
      }
      if (continuedEvent && /^\s*["']?APPROVE\b/.test(line)) {
        hits.push({ filePath, line: index + 1, reason: 'APPROVE review event' });
      }
      if ((reviewOnLine || continuedReview) && approveFlag.test(line)) {
        hits.push({ filePath, line: index + 1, reason: 'gh pr review approval flag' });
      }
      const usedAction = actionUse.exec(line);
      if (usedAction && approvalAction.test(usedAction[1])) {
        hits.push({ filePath, line: index + 1, reason: 'Approval action in uses' });
      }
    }
    continuedReview = (reviewOnLine || continuedReview) && /\\\s*$/.test(line);
    continuedEvent = /\bevent["']?\s*:\s*$/.test(line);
  }
  return hits;
}

function workflowFiles(root) {
  const files = [];
  for (const [subdir, include] of [
    ['workflows', name => /\.ya?ml$/.test(name)],
    ['actions', name => /^action\.ya?ml$/.test(name)],
  ]) {
    const base = join(root, '.github', subdir);
    const visit = directory => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && include(entry.name)) files.push(path);
      }
    };
    visit(base);
  }
  return files.sort();
}

function annotation(hit) {
  const path = hit.filePath
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/,/g, '%2C');
  console.log(`::error file=${path},line=${hit.line}::${hit.reason}`);
}

function main(args) {
  let hits = [];
  if (args.length === 2 && args[0] === '--stdin') {
    hits = scanContent(readFileSync(0, 'utf8'), args[1]);
  } else if (args.length === 0) {
    const root = process.cwd();
    const files = workflowFiles(root);
    for (const path of files) {
      hits.push(...scanContent(readFileSync(path, 'utf8'), relative(root, path)));
    }
    console.log(
      `Approve-review guard: scanned ${files.length} file(s); ${hits.length} finding(s).`,
    );
  } else {
    console.error('usage: check-approve-review-guard.mjs [--stdin <file-path>]');
    return 2;
  }
  for (const hit of hits) annotation(hit);
  return hits.length > 0 ? 1 : 0;
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
) {
  process.exitCode = main(process.argv.slice(2));
}
