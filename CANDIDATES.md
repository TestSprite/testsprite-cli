# Candidate Improvements

## Candidates

1. Picked: make the test suite portable on Windows.
   Evidence: `npm test -- src/lib/credentials.test.ts` failed on Windows before the patch because POSIX mode assertions saw `0o666` instead of `0o600`, and the default credentials path assertion assumed `/` separators. The full suite also failed where subprocess tests used `HOME` but not `USERPROFILE`, tried to unset inherited env vars with `undefined`, spawned `npm` directly, and compared POSIX path strings. Fixed in `src/lib/credentials.test.ts:22`, `test/cli.subprocess.test.ts:379`, `test/helpers/npm.ts:3`, `src/lib/skill-nudge.test.ts:11`, `src/lib/agent-targets.test.ts:36`, and `src/lib/bundle.test.ts:594`.

2. `doctor` bypasses the shared `--output` validator.
   Evidence: `src/commands/doctor.ts:260` assigns `globals.output ?? 'text'` directly, while the shared validator at `src/lib/output.ts:32` rejects invalid modes with a typed `VALIDATION_ERROR`.

3. Empty `TESTSPRITE_PROFILE` is not normalized like the other env vars.
   Evidence: `src/lib/config.ts:20` normalizes empty env values, but `src/lib/config.ts:42` reads `env.TESTSPRITE_PROFILE` raw before `readProfile`; malformed profile names are rejected at `src/lib/credentials.ts:38`.

4. `--password-file` strips leading and trailing spaces from passwords.
   Evidence: project create/update both use `readFileSync(...).trim()` at `src/commands/project.ts:205` and `src/commands/project.ts:326`, which changes a password whose value intentionally starts or ends with whitespace.

5. `resolveBundleDir` trims only POSIX trailing slashes.
   Evidence: `src/lib/bundle.ts:328` checks only `rawPath.endsWith('/')`; `src/lib/junit-report.ts:201` shows the safer local pattern of accepting both `/` and `\\`.

## Picked Rationale

I picked the Windows test portability issue because it was directly reproducible, blocked the documented `npm test` contributor loop on this workspace, and could be fixed entirely in tests without changing CLI behavior.

## Diff Summary

- Added `test/helpers/npm.ts` so subprocess-style tests run `npm run build` through the current npm entrypoint, with a Windows `.cmd` fallback.
- Isolated subprocess tests from the real Windows user profile by setting both `HOME` and `USERPROFILE`, and by removing inherited TestSprite API env vars case-insensitively.
- Made permission-bit assertions POSIX-only where Node/Windows cannot represent `0o600` reliably.
- Made path and CRLF-sensitive test assertions separator/line-ending neutral.

## Validation

- `npx -y -p node@22 -p npm@10 npm test` - passed, 50 files / 1846 tests.
- `npx -y -p node@22 -p npm@10 npm run lint:fix` - passed.
- `npx -y -p node@22 -p npm@10 npm run typecheck` - passed.
- `npx -y -p node@22 -p npm@10 npm run build` - passed.

## PR Title

test: make Windows CLI test harness portable

## PR Body

Summary:
- make path and CRLF-sensitive tests portable across Windows and POSIX
- isolate subprocess tests from the real Windows user profile and inherited TestSprite env vars
- run subprocess build setup through the active npm entrypoint instead of assuming `npm` is directly spawnable

Tests:
- `npm test`
- `npm run lint:fix`
- `npm run typecheck`
- `npm run build`
