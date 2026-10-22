#!/usr/bin/env node
// Runs the unit suite (`vitest run`), re-executing under `setpriv` first to
// drop CAP_DAC_OVERRIDE / CAP_DAC_READ_SEARCH when the process holds them
// (root inside a container, or a non-root sandbox uid with the full set).
// With those capabilities present the kernel skips permission checks
// entirely, so every test that pins the CLI's EACCES → "permission denied"
// mapping via a chmod-0o000 file would see the read succeed and has to skip
// (see test/helpers/fsModeEnforcement.ts). Dropping the capabilities
// restores real mode-bit enforcement, so those tests execute — on macOS,
// Windows, and runners that never hold the capabilities this script is a
// plain pass-through.
//
// Any guard miss (not Linux, capability unreadable or absent, no setpriv,
// setpriv failed to exec) falls back to running vitest directly, so
// `npm test` never becomes harder to run than plain `vitest run`. CLI args
// pass through:
//   npm run test -- src/lib/bundle.test.ts
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vitestEntry = join(root, 'node_modules', 'vitest', 'vitest.mjs');

function holdsDacOverride() {
  if (process.platform !== 'linux') return false;
  let status;
  try {
    status = readFileSync('/proc/self/status', 'utf8');
  } catch {
    return false; // no /proc → can't know → run as-is rather than guess
  }
  const capEff = /^CapEff:\s*([0-9a-f]+)$/m.exec(status);
  if (!capEff) return false;
  // Bit 1 of the capability set is CAP_DAC_OVERRIDE. Not gated on the
  // effective uid: a non-root process in a user namespace (e.g. a sandboxed
  // CI runner) holds the full set just like root in a container does.
  return (BigInt(`0x${capEff[1]}`) & 0b10n) !== 0n;
}

const args = process.argv.slice(2);

function runVitest() {
  if (!existsSync(vitestEntry)) {
    console.error('run-tests: node_modules/vitest/vitest.mjs not found — run `npm ci` first.');
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [vitestEntry, 'run', ...args], { stdio: 'inherit' });
  if (res.error) {
    console.error(`run-tests: could not spawn vitest: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

if (!holdsDacOverride()) {
  runVitest();
}

// `setpriv --help` doubles as the availability probe (util-linux, exit 0).
const setpriv = spawnSync('setpriv', ['--help']);
if (setpriv.error) {
  runVitest();
}

const dropped = spawnSync(
  'setpriv',
  [
    '--bounding-set=-dac_override,-dac_read_search',
    '--inh-caps=-dac_override,-dac_read_search',
    '--ambient-caps=-dac_override,-dac_read_search',
    process.execPath,
    vitestEntry,
    'run',
    ...args,
  ],
  { stdio: 'inherit' },
);
if (dropped.error) {
  // Exec failed for an unexpected reason — fall back to the plain run rather
  // than turning a test command into a hard failure.
  console.error(`run-tests: setpriv re-exec failed (${dropped.error.message}); running as-is.`);
  runVitest();
}
process.exit(dropped.status ?? 1);
