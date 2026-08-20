/**
 * Fail the security lint only on ERROR-severity findings that land on lines
 * THIS change actually added or modified.
 *
 * This is the "changed-line" half of the gate. The other half — the
 * committed `eslint-suppressions.security.json` baseline — has already removed the
 * pre-existing backlog from the ESLint report before it reaches this script,
 * so what remains is genuinely new/excess findings; this step additionally
 * narrows them to the diff's own lines so a large legacy file (e.g.
 * `src/commands/test.ts`) does not fail a release just for being touched.
 *
 * Input:  argv[2] = path to an ESLint JSON report (already baseline-filtered)
 *         env RESOLVED_BASE = base commit to diff against ('' = no base)
 *         env HEAD_SHA      = head commit (default 'HEAD')
 * Exit:   1 if any error finding falls on an added/changed line, else 0.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('usage: filter-changed-line-findings.mjs <eslint-report.json>');
  process.exit(2);
}

const base = (process.env.RESOLVED_BASE || '').trim();
const head = (process.env.HEAD_SHA || 'HEAD').trim();
const root = process.cwd();
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

/**
 * The set of line numbers this diff added/modified in `relPath`, parsed from
 * `git diff --unified=0` hunk headers (`@@ -a,b +c,d @@` → lines c..c+d-1).
 * Returns null to mean "keep every finding" — used when there is no base to
 * diff against (a genuine first commit / full-tree fallback) or the diff
 * cannot be computed, so nothing new is ever silently hidden.
 */
function addedLines(relPath) {
  if (!base) return null;
  let out;
  try {
    out = execFileSync(
      'git',
      ['diff', '--unified=0', '--diff-filter=ACMR', base, head, '--', relPath],
      { encoding: 'utf8' },
    );
  } catch {
    return null;
  }
  const lines = new Set();
  for (const line of out.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // count === 0 is a pure deletion at that position — no added line.
    for (let i = 0; i < count; i++) lines.add(start + i);
  }
  return lines;
}

const offenders = [];
for (const result of report) {
  const errors = (result.messages || []).filter(m => m.severity === 2);
  if (errors.length === 0) continue;
  const rel = result.filePath.startsWith(`${root}/`)
    ? result.filePath.slice(root.length + 1)
    : result.filePath;
  const scope = addedLines(rel);
  for (const m of errors) {
    if (scope === null || scope.has(m.line)) {
      offenders.push(`${rel}:${m.line}:${m.column}  ${m.ruleId}  ${m.message}`);
    }
  }
}

if (offenders.length > 0) {
  console.error(
    `Security lint: ${offenders.length} finding(s) on lines this change added/modified ` +
      `(and not in eslint-suppressions.security.json):\n`,
  );
  for (const o of offenders) console.error(`  ${o}`);
  console.error(
    '\nFix them, or if the call is genuinely safe, disable the specific rule at that line ' +
      'with a justification comment. Do NOT regenerate the baseline to hide new findings.',
  );
  process.exit(1);
}

console.log(
  'Security lint: no new findings on changed lines. ' +
    '(The pre-existing backlog is baselined in eslint-suppressions.security.json.)',
);
