import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseRepoSlug } from '../ci-linkage.js';
import { CLIError } from '../errors.js';
import { REDACTED } from '../redact.js';

export type Git = (args: string[], cwd: string) => { ok: boolean; stdout: string };

export const runGit: Git = (args, cwd) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, stdout: result.stdout ?? '' };
};

export interface Repository {
  root: string;
  name?: string;
  branch?: string;
  commit?: string;
}

/** The git repository the CLI runs in, or null outside one. */
export function readRepository(cwd: string, git: Git = runGit): Repository | null {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  if (!root.ok) return null;
  const at = root.stdout.trim();
  const remote = git(['remote', 'get-url', 'origin'], at);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], at);
  const commit = git(['rev-parse', '--short', 'HEAD'], at);
  const name = remote.ok ? (parseRepoSlug(remote.stdout) ?? undefined) : undefined;
  return {
    root: at,
    ...(name ? { name } : {}),
    ...(branch.ok && branch.stdout.trim() !== 'HEAD' ? { branch: branch.stdout.trim() } : {}),
    ...(commit.ok ? { commit: commit.stdout.trim() } : {}),
  };
}

/** Files never sent, whatever the change: where keys and passwords are kept. */
const SECRET_FILE =
  /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks|secret)|id_(rsa|ed25519|ecdsa)(\.pub)?|\.npmrc|\.netrc|\.pypirc|(credentials|secrets)\.(json|ya?ml|toml)|service-account.*\.json)$/i;

/** Well-known credential formats, blanked wherever they appear in the change. */
const SECRET_VALUE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];

/** Untracked files larger than this are left out: a new feature is source, not data. */
const MAX_NEW_FILE_BYTES = 256 * 1024;
/** The most the change may weigh; past it, a closer base names a smaller change. */
export const MAX_CHANGE_BYTES = 5 * 1024 * 1024;

export interface Change {
  /** What the patch is taken against: a commit, or HEAD for uncommitted work only. */
  base: string;
  patch: string;
  files: string[];
  /** Files left out: they may hold secrets, are binary, or are too large to be source. */
  left: string[];
}

/**
 * The change being worked on, as one patch: everything since `base`
 * (default: where this branch left the remote's default branch), committed or
 * not, with new untracked files; minus files that may hold secrets, and with
 * known credential formats blanked.
 */
export function readChange(repo: Repository, base: string | undefined, git: Git = runGit): Change {
  const from = base ?? defaultBase(repo.root, git);
  const tracked = git(['diff', '--name-only', from, '--'], repo.root);
  if (!tracked.ok) {
    throw new CLIError(
      `Can't diff against ${from}: no such commit or branch here.`,
      5,
      'VALIDATION_ERROR',
    );
  }
  const left: string[] = [];
  const allowed = (path: string) => {
    if (!SECRET_FILE.test(path)) return true;
    left.push(path);
    return false;
  };
  const trackedFiles = lines(tracked.stdout).filter(allowed);
  const parts: string[] = [];
  if (trackedFiles.length) {
    const diff = git(
      ['diff', '--no-color', '--no-ext-diff', from, '--', ...trackedFiles],
      repo.root,
    );
    if (diff.ok) parts.push(diff.stdout);
  }
  const newFiles: string[] = [];
  const untracked = git(['ls-files', '--others', '--exclude-standard'], repo.root);
  for (const path of lines(untracked.stdout).filter(allowed)) {
    const section = newFileSection(repo.root, path);
    if (section === null) left.push(path);
    else {
      parts.push(section);
      newFiles.push(path);
    }
  }
  const patch = blankSecrets(parts.join(''));
  if (Buffer.byteLength(patch) > MAX_CHANGE_BYTES) {
    throw new CLIError(
      `The change since ${from} is over ${MAX_CHANGE_BYTES / 1024 / 1024} MB. Name a closer base with --diff <commit>.`,
      5,
      'VALIDATION_ERROR',
    );
  }
  return { base: from, patch, files: [...trackedFiles, ...newFiles], left };
}

/** A new file as a patch section, the way `git diff` shows one; null for a binary or large file. */
function newFileSection(root: string, path: string): string | null {
  const full = join(root, path);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- an untracked file git lists in the user's own repository, read to attach it with the change.
  if (statSync(full).size > MAX_NEW_FILE_BYTES) return null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- an untracked file git lists in the user's own repository, read to attach it with the change.
  const bytes = readFileSync(full);
  if (bytes.includes(0)) return null;
  const body = bytes.toString('utf8');
  const content = body.endsWith('\n') ? body.slice(0, -1) : body;
  const added = content === '' ? [] : content.split('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    ...(added.length ? [`@@ -0,0 +1,${added.length} @@`, ...added.map(l => `+${l}`)] : []),
    '',
  ].join('\n');
}

export function blankSecrets(text: string): string {
  return SECRET_VALUE.reduce((out, pattern) => out.replace(pattern, REDACTED), text);
}

function defaultBase(root: string, git: Git): string {
  for (const remoteHead of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const forkPoint = git(['merge-base', 'HEAD', remoteHead], root);
    if (forkPoint.ok && forkPoint.stdout.trim()) return forkPoint.stdout.trim();
  }
  return 'HEAD';
}

const lines = (text: string) =>
  text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
