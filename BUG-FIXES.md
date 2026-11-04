# BUG-FIXES

## 2026-10-16 — `npm run test` failed with 6 permission-denied test failures

### Symptoms

`npm run test` reported **3 failed test files / 6 failed tests** (out of 4,588):

```
FAIL src/commands/doctor.test.ts
  × a real unreadable file does not leak EACCES into the Connectivity or Local tunnel checks

FAIL src/commands/test.test.ts  (3 failures)
  × --steps (test plan put)      > an unreadable file reports VALIDATION_ERROR "permission denied"
  × --steps (test plan put)      > a directory the process cannot even traverse into reports the dedicated wording
  × --plan-from (create-from-plan) > an unreadable file reports VALIDATION_ERROR "permission denied"
  × --plans (test create-batch)    > an unreadable file reports VALIDATION_ERROR "permission denied"

FAIL src/lib/secret-file.test.ts
  × readSecretFileGuarded > permission denied > reports permission denied rather than crashing
```

Example assertion failure (test.test.ts):

```
expected TransportError: fetch failed { code: 'UNAVAILABLE', ... }
to match object { code: 'VALIDATION_ERROR', nextAction: /cannot read .*EACCES/ }
```

and (secret-file.test.ts):

```
AssertionError: expected "should have thrown" not to be reached
```

### Root cause

Not a product bug — the **production code behaved correctly** in every case. The
failings tests share one environment-dependent premise: that
`chmodSync(path, 0o000)` makes a file (or directory) unreadable so the CLI
produces its `VALIDATION_ERROR` "permission denied" mapping.

That premise does not hold in containers: when the test process runs with
**`CAP_DAC_OVERRIDE`** (typical for Docker containers and root users), the
kernel skips permission checks entirely, the mode-`0o000` file **stays
readable**, no `EACCES` is ever raised, and:

- the guarded reads succeed, so the code proceeds past the guard and fails
  downstream instead of throwing `VALIDATION_ERROR` (`expect.unreachable`
  fires), or
- assertions expecting `cannot be read (EACCES)` output simply never see it.

Verified directly in the affected environment:

```
$ node -e "require('fs').readFileSync('/tmp/mode-000-file')"
# read succeeded despite mode 000  →  CAP_DAC_OVERRIDE active
$ grep CapEff /proc/self/status
CapEff: 000001ffffffffff   # bit 1 = CAP_DAC_OVERRIDE
```

The tests already acknowledged the sibling limitation (`process.platform ===
'win32'`, where mode bits are a no-op against ACLs) via `it.skipIf`, but did not
account for capability-holding POSIX processes.

### Fix

Made the mode-bit premise **verified, not assumed**, instead of letting these
tests fail in privileged environments:

- **New helper `test/helpers/fsModeEnforcement.ts`** — exports
  `FS_ENFORCES_MODE_BITS`, probed once per process: it writes a scratch file in
  a `mkdtempSync` temp dir, `chmod`s it to `0o000`, and checks whether the OS
  actually denies the read. Reports `false` on Windows outright (matching the
  existing skip guards).
- **Six test sites updated** to skip when the filesystem cannot be made to
  deny access, extending the existing skip condition rather than replacing it:
  - `src/commands/test.test.ts` — the three `--steps` / `--plan-from` /
    `--plans` "unreadable file" tests and the "locked directory traversal"
    test
  - `src/commands/doctor.test.ts` — the "real unreadable file does not leak
    EACCES" test
  - `src/lib/secret-file.test.ts` — `readSecretFileGuarded` "permission
    denied" test

  The skip condition is now
  `it.skipIf(process.platform === 'win32' || !FS_ENFORCES_MODE_BITS)`, so the
  tests still run — and still pin the EACCES-mapping regression — on any
  normal Linux/macOS developer machine or CI runner, and are cleanly skipped
  with a documented reason in containers where the premise is impossible.

### Result

`npm run test`: **4,580 passed | 8 skipped | 0 failed** (the 8 skips are the 6
tests above plus 2 that were already skipped before this change). The six
tests now skip (rather than fail) in capability-holding environments and
continue to exercise the permission-denied code paths everywhere the OS can
actually produce EACCES.

The "runs normally on a standard machine" claim was also verified _in this
same container_ by removing the bypass capabilities from the test process and
its children with `setpriv` (dropping `CAP_DAC_OVERRIDE` and
`CAP_DAC_READ_SEARCH` from the inheritable, ambient, and bounding sets):

```
$ setpriv --bounding-set=-dac_override,-dac_read_search \
    --inh-caps=-dac_override,-dac_read_search \
    --ambient-caps=-dac_override,-dac_read_search npm run test

 Test Files  115 passed (115)
      Tests  4586 passed | 2 skipped (4588)
```

With the kernel enforcing mode bits again, the probe flips to `true` and all
six previously-skipped tests **run and pass** (4,586 = 4,580 + 6; only the 2
pre-existing skips remain). The identical 115 files pass in both environments,
so the skip guard is the only behavioral difference and the EACCES mapping is
exercised for real wherever the OS permits it.

## 2026-10-16 (follow-up) — the remaining 8 skipped tests now execute everywhere

### Symptoms

With the failure from above fixed, `npm run test` still reported
**8 skipped | 0 failed**:

- 6 skips: the chmod-based EACCES-mapping tests above, skipped in any
  capability-holding environment (verified equivalent only via the manual
  `setpriv` invocation, not by the default `npm test` path).
- 2 skips: the two `resolveBundleDir` tests in `src/lib/bundle.test.ts`
  gated on `it.runIf(process.platform === 'win32')` — "strips a trailing
  backslash (native Windows path)" and "preserves a bare Windows drive root
  instead of truncating it to a drive-relative path" — skipped on every
  non-Windows machine.

### Root causes

1. **Capability-holding processes make mode bits advisory.** The skip guard
   was the correct _fallback_, but the default `npm test` path did nothing
   about it: in a container (root) or user-namespace sandbox (non-root uid
   with the full capability set — this repo's CI sandbox is such an
   environment), `CAP_DAC_OVERRIDE` stays in the effective set, the probe in
   `test/helpers/fsModeEnforcement.ts` correctly reports `false`, and 6 real
   regression tests never execute. The capability can be dropped from the
   process's own inheritable/ambient/bounding sets via `setpriv` before
   vitest spawns its workers — no root privilege is needed to drop your own
   capabilities — but nothing did that automatically.
2. **The two `resolveBundleDir` tests conflated two concerns.** Their
   assertions decompose into (a) `stripTrailingSeparators` — pure string
   logic handling `\` separators and the `C:\` drive-root special case,
   identical on every platform — and (b) node's platform-native
   `isAbsolute('C:\\...')` returning `true`, which only holds under an
   actual win32 runtime. The tests gated _both_ on win32 when only (b) is
   platform-bound; (a) is exactly the logic that could regress and it ran
   nowhere outside Windows.

### Fixes

1. **`scripts/run-tests.mjs` (new) + `test` npm script now runs through it.**
   On Linux, when `CapEff` shows `CAP_DAC_OVERRIDE` (bit 1) — checked
   directly in `/proc/self/status`, deliberately _not_ gated on the effective
   uid, since user-namespace sandboxes hold the full set as non-root — the
   script re-executes vitest under `setpriv`, dropping both capabilities
   from the bounding/inheritable/ambient sets (the exact invocation is in
   the script, and verbatim in the section above) so the kernel enforces
   mode bits again and the probe flips to `true`. On macOS, Windows, plain
   non-root runners (where the capabilities are never held), or if `setpriv`
   is missing or fails to exec, it falls back to a plain `vitest run`, so
   `npm test` never becomes harder to run. CLI args pass through
   (`npm run test -- <file>`).
2. **`bundle.test.ts`**: exported `stripTrailingSeparators` from
   `src/lib/bundle.ts` (pure string logic, no behavior change) and rewrote
   the two win32-gated tests as always-running assertions against it —
   trailing-backslash stripping and drive-root preservation now run on every
   platform. The genuinely win32-bound part (node's `isAbsolute`
   recognizing `C:\…`) is node's own behavior and is exercised by the
   Windows CI leg rather than re-asserted on Linux.

### Result

`npm run test` in this previously-skipping environment now reports
**115 files passed, 4,588 passed | 0 skipped | 0 failed** — every test in the
suite executes by default, including all 6 EACCES-mapping tests and the 2
Windows-path tests. The arithmetic checks out: 4,580 (baseline passing) + 2
(converted bundle tests) + 6 (mode-bit tests now running under dropped
capabilities) = 4,588.

## 2026-10-16 (follow-up) — `billing-refusal-render.subprocess.test.ts` timed out under a loaded machine

### Symptom

`npm run test` reported **1 failed test file** (out of 115):

```
FAIL test/billing-refusal-render.subprocess.test.ts > billing refusal
rendering in the built CLI > rollout text and JSON
Error: Test timed out in 5000ms.
```

The full run had taken ~960s (a heavily contended machine). The same file
passed when run alone, and its per-spawn `spawnSync` timeout of 10s never
fired — only vitest's per-test timeout did.

### Root cause

Not a product bug. Each `it.each` case spawns the built CLI **twice** (text
mode + `--output json`), and every spawn is allowed up to its own 10s
`spawnSync` timeout — up to ~20s of legitimate runtime per case. But the
vitest-level per-test timeout was left at the **5s default**, so any case
whose two subprocess runs together took longer than 5s — easily possible on
a loaded machine, where the suite itself runs 5× slower — was killed as a
timeout even though both child processes were behaving normally.

Reproduced the mechanism by adding CPU contention (32 busy-loops on a 4-core
box): the file's aggregate test time went from 2.4s (uncontended) → 30.7s,
with **4 of the 6 cases failing with the exact `Test timed out in 5000ms`
signature** from the report.

### Fix

Set an explicit per-test timeout of **30s** on the `it.each` cases
(`perTestTimeout`), matching the repo's existing convention for
subprocess suites — `test/cli.subprocess.test.ts` already declares explicit
30–60s timeouts on its tests. 30s covers the ~20s worst case (two spawns at
their full 10s `spawnSync` timeout each) with headroom. No test logic
changed. The two sibling subprocess suites —
`test/tunnel-limit-render.subprocess.test.ts` (one test, two spawns) and
`test/history-retention.subprocess.test.ts` (two `describe.each` tests, one
spawn each) — had the identical latent gap and got the same 30s timeout.

### Result

With the same contention that previously failed 4/6 cases, the file now
reports **6 passed (6)**. The full suite still reports **115 files passed,
4,588 passed | 0 skipped | 0 failed**.
