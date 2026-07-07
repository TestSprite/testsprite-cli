import { execFileSync } from 'node:child_process';

export function runNpmScript(script: string, cwd: string): void {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    execFileSync(process.execPath, [npmExecPath, 'run', script], { cwd, stdio: 'pipe' });
    return;
  }
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
    cwd,
    stdio: 'pipe',
  });
}
