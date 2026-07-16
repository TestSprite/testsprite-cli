import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface GitUtilsDeps {
  existsSync?: (p: string) => boolean;
  exists?: (p: string) => Promise<boolean>;
  readFile?: (p: string) => Promise<string>;
  writeFile?: (p: string, content: string) => Promise<void>;
}

/**
 * Checks if the specified directory is inside a Git repository by recursively walking
 * up the directory tree to check for a `.git` folder or file.
 */
export function isInsideGitRepo(dir: string, deps: GitUtilsDeps = {}): boolean {
  const exists = deps.existsSync ?? existsSync;

  try {
    let current = dir;
    while (true) {
      const gitDir = join(current, '.git');
      if (exists(gitDir)) {
        return true;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  } catch {
    // Best-effort: if the filesystem check fails, treat as not a git repo.
  }
  return false;
}

/**
 * Checks if `.testsprite` is ignored given the raw content of a `.gitignore` file.
 */
export function isTestspriteIgnored(content: string): boolean {
  const lines = content.split(/\r?\n/);
  let ignored = false;
  for (const line of lines) {
    const cleaned = line.replace(/#.*$/, '').trim();
    if (!cleaned) continue;

    // A negation pattern like `!.testsprite/` un-ignores the directory.
    const isNegation = cleaned.startsWith('!');
    const pattern = isNegation ? cleaned.slice(1) : cleaned;

    if (
      pattern === '.testsprite' ||
      pattern === '.testsprite/' ||
      pattern === '**/.testsprite' ||
      pattern === '**/.testsprite/' ||
      pattern.startsWith('.testsprite/') ||
      pattern.startsWith('**/.testsprite/')
    ) {
      ignored = !isNegation;
    }
  }
  return ignored;
}

/**
 * Returns true if a `.gitignore` exists in the target directory and ignores `.testsprite/`.
 */
export async function checkTestspriteIgnored(dir: string, deps: GitUtilsDeps = {}): Promise<boolean> {
  const exists = deps.exists ?? (async (p) => (deps.existsSync ?? existsSync)(p));
  const read = deps.readFile ?? ((p) => fs.readFile(p, 'utf8'));

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
 * Ensures that `.testsprite/` is ignored in the target directory's `.gitignore`.
 * If `.gitignore` doesn't exist, it will be created. If `.testsprite` is already
 * ignored, no changes are made.
 *
 * Returns true if the file was modified or created, false if it was already ignored.
 */
export async function ensureTestspriteIgnored(dir: string, deps: GitUtilsDeps = {}): Promise<boolean> {
  const exists = deps.exists ?? (async (p) => (deps.existsSync ?? existsSync)(p));
  const read = deps.readFile ?? ((p) => fs.readFile(p, 'utf8'));
  const write = deps.writeFile ?? ((p, content) => fs.writeFile(p, content, 'utf8'));

  const gitignorePath = join(dir, '.gitignore');
  let content = '';
  if (await exists(gitignorePath)) {
    try {
      content = await read(gitignorePath);
    } catch {
      content = '';
    }
  }

  if (isTestspriteIgnored(content)) {
    return false; // already ignored, no changes made
  }

  // Ensure file ends with newline before appending
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const appendContent = `${separator}\n# TestSprite failure artifacts\n.testsprite/\n`;
  const newContent = `${content}${appendContent}`;

  await write(gitignorePath, newContent);
  return true; // appended successfully
}
