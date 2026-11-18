import path from 'node:path';
import { CLIError } from './errors.js';

export interface TargetPathFs {
  lstat(p: string): Promise<{ isFile: boolean; isSymbolicLink: boolean } | null>;
}

/**
 * Inspect existing components before creating a target. Symlinks are refused
 * unless the caller supplies a policy that validates their destination.
 * Returns null at the first missing component. A race between inspection and
 * writing remains, as with the agent installer's original path guard.
 */
export async function inspectTargetPath(
  agentFs: TargetPathFs,
  root: string,
  relPath: string,
  allowSymlink?: (target: string) => Promise<void>,
): Promise<{ isFile: boolean } | null> {
  const segments = relPath.split(process.platform === 'win32' ? /[/\\]+/ : /\/+/).filter(Boolean);
  let current = root;
  let finalIsFile = false;
  for (const [i, seg] of segments.entries()) {
    current = path.join(current, seg);
    const ls = await agentFs.lstat(current);
    if (ls === null) {
      // This component and everything below it does not exist yet.
      return null;
    }
    if (ls.isSymbolicLink && allowSymlink) {
      await allowSymlink(current);
    } else if (ls.isSymbolicLink) {
      const shown = segments.slice(0, i + 1).join('/');
      throw new CLIError(
        `refusing to write through a symlink: "${shown}" — installing here could place files outside --dir. Remove the symlink or choose a different --dir.`,
        5,
      );
    }
    if (i < segments.length - 1 && ls.isFile) {
      const shown = segments.slice(0, i + 1).join('/');
      throw new CLIError(`cannot create ${relPath}: "${shown}" exists and is not a directory.`, 5);
    }
    finalIsFile = ls.isFile;
  }
  return { isFile: finalIsFile };
}
