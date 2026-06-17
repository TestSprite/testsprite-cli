import { execFileSync } from 'node:child_process';

/** Cross-platform `npm` invocation (Windows needs `shell: true` for `.cmd` shims). */
export function execNpm(
  args: string[],
  options: { cwd: string; stdio?: 'pipe' | 'inherit' | 'ignore' },
): Buffer | string {
  return execFileSync('npm', args, {
    ...options,
    shell: process.platform === 'win32',
  });
}
