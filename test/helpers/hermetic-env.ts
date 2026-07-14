/**
 * Unit-test env hermeticity (vitest `setupFiles`, runs before each test file).
 *
 * Two leaks this closes, both of which made results depend on the
 * developer's machine:
 *
 * 1. Real `TESTSPRITE_*` env vars. `loadConfig` gives `TESTSPRITE_API_KEY`
 *    precedence over the credentials file, so a key exported in the
 *    developer's shell silently overrode test fixtures.
 * 2. The real home directory. `os.homedir()` reads `HOME` on POSIX but
 *    `USERPROFILE` on Windows, so the documented `HOME=$(mktemp -d)`
 *    recipe never isolated Windows runs. Both vars are redirected to a
 *    throwaway dir so no test can read or write `~/.testsprite`.
 *
 * Tests that need these vars set them explicitly (on `process.env` or via
 * injected `env` deps) after this runs.
 */
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const realHome = homedir();
const hermeticHome = mkdtempSync(join(tmpdir(), 'testsprite-unit-home-'));
if (process.platform === 'win32') {
  // Node version shims (Volta) resolve LocalAppData under USERPROFILE and
  // abort if it's missing, which would break the `npm run build` beforeAll
  // in the subprocess/snapshot suites.
  mkdirSync(join(hermeticHome, 'AppData', 'Local'), { recursive: true });
}
// Same shim concern on macOS/Linux: Volta derives ~/.volta from HOME unless
// VOLTA_HOME is set. Pin it to the real install before redirecting HOME.
const realVoltaHome = join(realHome, '.volta');
if (!process.env.VOLTA_HOME && existsSync(realVoltaHome)) {
  process.env.VOLTA_HOME = realVoltaHome;
}
process.env.HOME = hermeticHome;
process.env.USERPROFILE = hermeticHome;

for (const key of Object.keys(process.env)) {
  if (key.startsWith('TESTSPRITE_')) delete process.env[key];
}
