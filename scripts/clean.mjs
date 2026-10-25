#!/usr/bin/env node

import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');

/** Remove generated build and coverage output from a repository. */
export function clean(repositoryRoot = REPOSITORY_ROOT) {
  for (const directory of ['dist', 'coverage']) {
    rmSync(resolve(repositoryRoot, directory), { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  clean();
}
