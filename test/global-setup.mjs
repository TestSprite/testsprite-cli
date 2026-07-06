import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const distEntry = join(repoRoot, 'dist', 'index.js');
const srcDir = join(repoRoot, 'src');

function newestMtimeMs(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeMs(path));
    } else if (entry.isFile()) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

function needsBuild() {
  if (!existsSync(distEntry)) return true;
  return newestMtimeMs(srcDir) > statSync(distEntry).mtimeMs;
}

/** Runs once before any test file worker — shared dist/ for subprocess suites. */
export default async function globalSetup() {
  if (!needsBuild()) return;
  execSync('npm run build', { cwd: repoRoot, stdio: 'inherit' });
}
