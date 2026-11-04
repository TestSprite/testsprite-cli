/**
 * Whether this process's filesystem actually enforces POSIX mode bits.
 *
 * Tests that simulate an unreadable file with `chmodSync(path, 0o000)` only
 * get the intended EACCES when the kernel applies permission checks to this
 * process. In containers (and anywhere a process runs with CAP_DAC_OVERRIDE,
 * e.g. as root), mode bits are advisory: the file stays readable and no
 * EACCES can be produced by chmod alone. Probed once per process rather than
 * inferred from the effective uid, because capability-aware checks are not
 * portable across platforms.
 *
 * Windows is reported as "not enforced" outright: 0o000 has no effect there
 * (ACLs are a different mechanism), matching the existing
 * `it.skipIf(process.platform === 'win32')` guards.
 */
import { chmodSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FS_ENFORCES_MODE_BITS: boolean = (() => {
  if (process.platform === 'win32') return false;
  const dir = mkdtempSync(join(tmpdir(), 'testsprite-mode-probe-'));
  const file = join(dir, 'probe.txt');
  try {
    writeFileSync(file, 'x');
    chmodSync(file, 0o000);
    try {
      readFileSync(file);
      return false; // readable despite 0o000 -> mode bits are advisory here
    } catch {
      return true;
    }
  } finally {
    try {
      chmodSync(file, 0o600);
    } catch {
      // Nothing to recover: the dir is force-removed below either way.
    }
    rmSync(dir, { recursive: true, force: true });
  }
})();
