/**
 * Guard against internal tracker ticket numbers (DEV-<n>, TES-<n>, DES-<n>)
 * landing in code, tests, workflows, or scripts. Those numbers are meaningless
 * to anyone outside this org and rot the moment a ticket is renamed, moved, or
 * closed — the constraint or rationale itself belongs in the comment; the
 * ticket number belongs in the PR description or commit message instead.
 *
 * Scope: src/, test/, .github/, scripts/, copybara/, and root config files
 * (package.json, eslint*.config.mjs, tsconfig*.json, vitest*.config.ts,
 * .prettierrc*). Docs (*.md, docs/), CHANGELOG*, and the internal
 * .backport-manifest ledger are exempt — a ticket reference there is expected
 * editorial content, not a code comment.
 *
 * Files that make-public-snapshot.sh drops from the public mirror (release
 * and backport workflows, operator scripts, copybara/) are scanned too, on
 * purpose: the rule is about code staying self-explanatory, not only about
 * what ships publicly. Do not exempt the DROP list to get a branch green —
 * rewrite the comment instead.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Case-sensitive on purpose: tracker IDs are always uppercase, while
// lowercase `dev-<n>` is an ordinary hostname or environment slug
// (e.g. `api.dev-1.example.com`) that must not fail lint.
const TICKET_REF = /\b(?:DEV|TES|DES)-\d+\b/;

const INCLUDE_PREFIXES = ['src/', 'test/', '.github/', 'scripts/', 'copybara/'];
const EXCLUDE_EXACT = new Set(['.backport-manifest', 'package-lock.json']);

// Root-level config files only (no '/' in the path) — matched by family so a
// future eslint/tsconfig/vitest/prettier variant is covered without editing
// this guard.
function isRootConfigFile(path) {
  if (path.includes('/')) return false;
  if (path === 'package.json') return true;
  if (/^eslint.*\.config\.mjs$/.test(path)) return true;
  if (/^tsconfig.*\.json$/.test(path)) return true;
  if (/^vitest.*\.config\.ts$/.test(path)) return true;
  if (/^\.prettierrc(?:\.\w+)?$/.test(path)) return true;
  return false;
}

export function isInScope(path) {
  if (EXCLUDE_EXACT.has(path)) return false;
  if (/\.md$/i.test(path)) return false;
  if (path === 'docs' || path.startsWith('docs/')) return false;
  if (/(?:^|\/)CHANGELOG/.test(path)) return false;
  if (isRootConfigFile(path)) return true;
  return INCLUDE_PREFIXES.some(prefix => path.startsWith(prefix));
}

/**
 * Pure scan of one file's already-decoded text content. Exported so tests can
 * exercise the matching/line-numbering logic without touching the filesystem
 * or git.
 */
export function scanContent(content, filePath) {
  const hits = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (TICKET_REF.test(line)) {
      hits.push({ filePath, line: index + 1, text: line.trim() });
    }
  }
  return hits;
}

// A NUL byte in the first few KB is a reliable, encoding-agnostic signal that
// a file is binary; skip it rather than risk reading garbage as text.
function isBinary(buffer) {
  const length = Math.min(buffer.length, 8000);
  for (let i = 0; i < length; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Enumerates tracked files under `root` via `git ls-files` (never fs
 * traversal, so this only ever sees what git itself would commit) and scans
 * every in-scope, non-binary one. `git ls-files` always returns forward-slash
 * paths, on every OS including Windows, so scope matching and the joins below
 * need no OS-specific handling.
 */
export function scanTree(root) {
  // `git ls-files` scopes its output to `cwd` and prints paths relative to
  // it — from a subdirectory that silently narrows the scan instead of
  // erroring. Resolve to the actual top of the working tree first so the
  // scan (and every path it reports) is always repo-wide, regardless of
  // which directory `root` names.
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();

  // `-z` NUL-terminates entries and disables git's default quoting of
  // non-ASCII/special-char paths (core.quotePath) — without it, a path like
  // `tëst.ts` comes back as a quoted, octal-escaped string that would then
  // fail to open and get silently skipped by the ENOENT guard below.
  // `-s` adds each entry's mode, so symlinks (120000) and submodules
  // (160000) are skipped from git's own record rather than by stat()ing the
  // working tree: a symlink's tracked content is its target path, while
  // `readFileSync` would follow it to whatever it resolves to on disk.
  const files = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map(entry => {
      const tab = entry.indexOf('\t');
      return { mode: entry.slice(0, entry.indexOf(' ')), relPath: entry.slice(tab + 1) };
    })
    .filter(({ mode }) => mode !== '120000' && mode !== '160000')
    .map(({ relPath }) => relPath);

  const hits = [];
  let scanned = 0;
  for (const relPath of files) {
    if (!isInScope(relPath)) continue;
    const fullPath = join(repoRoot, ...relPath.split('/'));
    let buffer;
    try {
      buffer = readFileSync(fullPath);
    } catch (error) {
      if (error.code === 'ENOENT') continue; // e.g. a gitlink / removed-but-tracked race
      throw error;
    }
    if (isBinary(buffer)) continue;
    scanned++;
    hits.push(...scanContent(buffer.toString('utf8'), relPath));
  }
  return { hits, scanned };
}

function main() {
  let result;
  try {
    result = scanTree(process.cwd());
  } catch (error) {
    console.error(`check-ticket-refs: could not list tracked files: ${error.message}`);
    return 2;
  }

  const { hits, scanned } = result;
  if (hits.length > 0) {
    for (const hit of hits) {
      console.error(`${hit.filePath}:${hit.line}: ${hit.text}`);
    }
    console.error(
      '\nInternal tracker ticket numbers (DEV-<n> / TES-<n> / DES-<n>) don’t belong in ' +
        'code, tests, workflows, or scripts: state the constraint or rationale itself in the ' +
        'comment, and keep the ticket number in the PR description or commit message instead.',
    );
    return 1;
  }

  console.log(`check-ticket-refs: clean, ${scanned} file(s) scanned.`);
  return 0;
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
) {
  process.exitCode = main();
}
