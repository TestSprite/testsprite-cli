import { existsSync, lstatSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Result of an lstat call: `null` means the path does not exist. */
export type GitUtilsStat = { isSymbolicLink: boolean } | null;

export interface GitUtilsDeps {
  existsSync?: (p: string) => boolean;
  exists?: (p: string) => Promise<boolean>;
  /** lstat semantics (never follows symlinks); used to refuse writing through a symlinked .gitignore. */
  lstat?: (p: string) => Promise<GitUtilsStat>;
  /** Sync lstat for diagnostics; a symlinked .gitignore is not trusted (git does not follow it). */
  lstatSync?: (p: string) => GitUtilsStat;
  readFile?: (p: string) => Promise<string>;
  readFileSync?: (p: string) => string;
  /** Appends text to the file, creating it when missing. */
  appendFile?: (p: string, text: string) => Promise<void>;
}

/**
 * Returns the nearest directory at or above `dir` that contains `.git` (a directory,
 * or a file as in worktrees and submodules), or null. `dir` is resolved to an absolute
 * path first so relative inputs walk the real tree.
 */
export function findGitRoot(dir: string, deps: GitUtilsDeps = {}): string | null {
  const exists = deps.existsSync ?? existsSync;
  let current = resolve(dir);
  while (true) {
    if (exists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Async variant of {@link findGitRoot}. Errors from the existence check propagate. */
export async function findGitRootAsync(
  dir: string,
  deps: GitUtilsDeps = {},
): Promise<string | null> {
  const exists = deps.exists ?? (async p => (deps.existsSync ?? existsSync)(p));
  let current = resolve(dir);
  while (true) {
    if (await exists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** True when `dir` is inside a Git repository (`.git` directory or file found at or above it). */
export function isInsideGitRepo(dir: string, deps: GitUtilsDeps = {}): boolean {
  return findGitRoot(dir, deps) !== null;
}

/** Async variant of {@link isInsideGitRepo}. */
export async function isInsideGitRepoAsync(dir: string, deps: GitUtilsDeps = {}): Promise<boolean> {
  return (await findGitRootAsync(dir, deps)) !== null;
}

/**
 * Checks if `.testsprite` is ignored given the raw content of a `.gitignore` file.
 */
export function isTestspriteIgnored(content: string): boolean {
  const lines = content.split(/\r?\n/);
  let ignored = false;
  let contentPatternActive = false;
  for (const line of lines) {
    const cleaned = line.trim();
    if (!cleaned || cleaned.startsWith('#')) continue;

    // A negation pattern like `!.testsprite/` un-ignores the directory.
    const isNegation = cleaned.startsWith('!');
    const pattern = isNegation ? cleaned.slice(1) : cleaned;

    if (
      pattern === '.testsprite' ||
      pattern === '.testsprite/' ||
      pattern === '**/.testsprite' ||
      pattern === '**/.testsprite/' ||
      pattern === '.testsprite/*' ||
      pattern === '.testsprite/**' ||
      pattern === '**/.testsprite/*' ||
      pattern === '**/.testsprite/**' ||
      pattern === '/.testsprite' ||
      pattern === '/.testsprite/' ||
      pattern === '/.testsprite/*' ||
      pattern === '/.testsprite/**'
    ) {
      ignored = !isNegation;
      contentPatternActive =
        !isNegation &&
        (pattern === '.testsprite/*' ||
          pattern === '.testsprite/**' ||
          pattern === '**/.testsprite/*' ||
          pattern === '**/.testsprite/**' ||
          pattern === '/.testsprite/*' ||
          pattern === '/.testsprite/**');
    }

    if (
      contentPatternActive &&
      isNegation &&
      (pattern.startsWith('.testsprite/') ||
        pattern.startsWith('**/.testsprite/') ||
        pattern.startsWith('/.testsprite/'))
    ) {
      ignored = false;
    }
  }
  return ignored;
}

/**
 * Returns true if a `.gitignore` exists in the target directory and ignores `.testsprite/`.
 */
export async function checkTestspriteIgnored(
  dir: string,
  deps: GitUtilsDeps = {},
): Promise<boolean> {
  const exists = deps.exists ?? (async p => (deps.existsSync ?? existsSync)(p));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads the target repository's .gitignore file
  const read = deps.readFile ?? (p => fs.readFile(p, 'utf8'));

  const gitignorePath = join(dir, '.gitignore');
  if (!(await exists(gitignorePath))) {
    return false;
  }

  try {
    const content = await read(gitignorePath);
    return isTestspriteIgnored(content);
  } catch {
    return false;
  }
}

/**
 * Synchronous check for diagnostics: is `dir` inside a Git repository, and is
 * `.testsprite/` ignored by a `.gitignore` between `dir` and the repository root
 * (inclusive)? Reads files only; never shells out to git and never throws.
 */
export function inspectTestspriteIgnore(
  dir: string,
  deps: GitUtilsDeps = {},
): { inRepo: boolean; ignored: boolean } {
  const exists = deps.existsSync ?? existsSync;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads the target repository's .gitignore file
  const read = deps.readFileSync ?? ((p: string) => readFileSync(p, 'utf8'));
  const lstatOf = deps.lstatSync ?? defaultLstatSync;
  const root = findGitRoot(dir, deps);
  if (root === null) return { inRepo: false, ignored: false };
  let current = resolve(dir);
  while (true) {
    const candidate = join(current, '.gitignore');
    try {
      // Git ignores a .gitignore that is a symlink, so its contents prove nothing.
      if (
        exists(candidate) &&
        !lstatOf(candidate)?.isSymbolicLink &&
        isTestspriteIgnored(read(candidate))
      ) {
        return { inRepo: true, ignored: true };
      }
    } catch {
      // Unreadable .gitignore: treat as not ignoring and keep walking.
    }
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { inRepo: true, ignored: false };
}

/**
 * Ensures that `.testsprite/` is ignored in the target directory's `.gitignore`.
 * Does nothing outside a Git repository. If `.gitignore` is missing it is created;
 * otherwise the entry is appended (never rewritten), so a concurrent edit is not lost.
 * Refuses to write through a symlinked `.gitignore` (throws).
 *
 * Returns true if the file was modified or created, false if nothing was changed.
 */
export async function ensureTestspriteIgnored(
  dir: string,
  deps: GitUtilsDeps = {},
): Promise<boolean> {
  const projectDir = resolve(dir);
  if (!(await isInsideGitRepoAsync(projectDir, deps))) {
    return false;
  }

  const exists = deps.exists ?? (async p => (deps.existsSync ?? existsSync)(p));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads the target repository's .gitignore file
  const read = deps.readFile ?? (p => fs.readFile(p, 'utf8'));
  const lstat = deps.lstat ?? defaultLstat;
  const append =
    deps.appendFile ??
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- appends to the target repository's .gitignore file
    ((p, text) => fs.appendFile(p, text, 'utf8'));

  const gitignorePath = join(projectDir, '.gitignore');
  const stat = await lstat(gitignorePath);
  if (stat?.isSymbolicLink) {
    throw new Error(`refusing to modify ${gitignorePath}: it is a symlink`);
  }

  let content = '';
  if (stat !== null || (await exists(gitignorePath))) {
    content = await read(gitignorePath);
  }

  if (isTestspriteIgnored(content)) {
    return false; // already ignored, no changes made
  }

  // Keep a leading newline when the file does not end with one so the entry starts on its own line.
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  await append(gitignorePath, `${separator}\n# TestSprite failure artifacts\n.testsprite/\n`);
  return true;
}

function defaultLstatSync(p: string): GitUtilsStat {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inspects the target repository's .gitignore without following symlinks
    return { isSymbolicLink: lstatSync(p).isSymbolicLink() };
  } catch {
    return null;
  }
}

async function defaultLstat(p: string): Promise<GitUtilsStat> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inspects the target repository's .gitignore without following symlinks
    const s = await fs.lstat(p);
    return { isSymbolicLink: s.isSymbolicLink() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
