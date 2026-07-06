# Changelog

All notable changes to `@testsprite/testsprite-cli` are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **JUnit XML report export for batch `--wait` runs.** `test run --all` and batch `test rerun` (`--all` or multiple test ids) accept `--report junit --report-file <path>` to write a CI-friendly XML sidecar after polling completes. `--output json` is unchanged; the report is written even when the batch exits non-zero. `--dry-run` writes a canned sample without network calls.
- **`testsprite test flaky <test-id>`** — repeat-run flaky-test detector. Replays a test N times (`--runs <n>`, default 5), aggregates the outcomes, and reports a stability verdict (`stable` / `flaky` / `failing`) plus the `runId` and `failureKind` of every attempt that did not pass. Replays run with auto-heal OFF (strict verbatim) so a healed drift can't mask a nondeterministic pass/fail. Exit code is 0 only when every attempt passed, so CI can gate a merge on flakiness (`testsprite test flaky <id> --runs 5 || exit 1`). Flags: `--runs <n>` (1–10), `--until-fail` (stop at the first non-passing attempt), `--timeout <s>` (per-attempt), and `--output json` for a machine-readable stability report. Frontend replays are free verbatim script replays; a one-line advisory is printed for backend tests, whose closure reruns may cost credits.

## [0.2.0] - 2026-06-29

### Added

- **Seed-suite onboarding skill.** `agent install` now installs a second skill by default — `testsprite-onboard` — which guides your coding agent to create a first test suite in a repository that doesn't have one yet (alongside the existing `testsprite-verify` skill). Use `agent install --skill <name>` to install only a specific subset.

### Changed

- **`test result` now reports the test verdict and execution status as separate fields.** The latest-result output gains a `verdict` field (the run's pass / fail / blocked judgement) and an `executionStatus` field (how the run terminated); `summary` is now a human-readable string.
  - **Breaking change to `--output json`:** `summary` was previously an object (`{ passed, failed, skipped }`). Scripts that read `summary.passed` / `.failed` / `.skipped` must move to the new `verdict` / `executionStatus` fields. The legacy `status` field is unchanged.
- `project create`, `project update`, and `test run --all` now print the `[dry-run] sample response — not from the server` banner under `--dry-run`, consistent with every other command.
- The CLI no longer suggests TypeScript/JavaScript test code is supported — TestSprite runs all test code as Python.

### Fixed

- **Security (failure-bundle writer):** `test failure get` and `test artifact get` now validate the response's step index and evidence kind before composing file paths, so a malformed or hostile API response can no longer write files outside the chosen `--out` directory.
- `test create --type backend` and `test code put` now reject a non-Python `--code-file` immediately with a clear validation error, instead of failing late server-side.
- `test failure get --out` is validated before the network call; `test code get --out` now writes atomically (no truncation if the fetch fails); artifact downloads retry on transient transport errors.
- Clearer validation messages for malformed `--endpoint-url` values and profile names; argument-parse errors now emit a structured JSON envelope under `--output json`.
- Batch rerun dispatch is de-duplicated and serialized.

## [0.1.2] - 2026-06-19

### Added

- **`testsprite setup`** — the onboarding command is now named `setup` (formerly `init`): configure your API key, verify it, and install the verification-loop skill for your coding agent in one shot. The old `init` name keeps working as a hidden, deprecated alias.

### Changed

- Onboarding consolidation — `setup` is now the single credential-writing command. The former granular commands are kept as hidden, deprecated aliases: `auth configure` → `setup`, `auth whoami` → `auth status`, `auth logout` → `auth remove`.
- The CLI now reports its version in the `User-Agent` header on each request.

## [0.1.1] - 2026-06-12

### Changed

- README: point the launch video at the updated public asset. Docs-only release — no code changes.

## [0.1.0] - 2026-06-10

### Added

- **`testsprite init`** — one-shot onboarding command that chains `auth configure` → `auth whoami` → `agent install` in a single interactive invocation. Accepts `--from-env`, `--yes`, and `--agent <target>` for non-interactive and CI use.

- **`agent install` / `agent list`** — write a ready-made TestSprite verification-loop skill file into your project so your coding agent knows the commands, the exit codes, and the failure-bundle layout. Pure-local command: no network, no credentials. Supported targets: `claude` (GA), `codex`, `cursor`, `cline`, `antigravity` (experimental). The `codex` target uses managed-section mode that writes a sentinel-delimited block inside `AGENTS.md` without clobbering surrounding content. `--force` backs up existing own-file targets before overwriting.

- **`auth configure` / `auth whoami` / `auth logout`** — API-key management. `--from-env` reads `TESTSPRITE_API_KEY` for non-interactive setup. Credentials stored at `~/.testsprite/credentials` (INI, mode `0600`).

- **`project list` / `project get`** — cursor-paginated project listing and single-project lookup.

- **`test list` / `test get`** — cursor-paginated test listing under a project (with `--status`, `--type`, `--created-from` filters) and single-test lookup.

- **`test create`** — create a frontend or backend test. Backend tests supply a code file directly (`--code-file`); frontend tests use `--code-file` or generate from a plan-steps document (`--plan-from`). The `--run --wait` flags chain create → trigger → poll in one invocation. Dependency metadata flags for backend tests: `--produces <var>` (repeatable), `--needs <var>` (repeatable), `--category <str>`.

- **`test create-batch`** — bulk-create frontend tests from a JSONL plan file (`--plans`) or a directory of plan files (`--plan-from-dir`). Optional `--run --max-concurrency <N>` fans out triggers.

- **`test update <test-id>` / `test delete <test-id>` / `test delete-batch`** — metadata update (name, description) and permanent hard-delete of one or many tests. `--confirm` is required for destructive operations. `test delete-batch` supports `--all --project <id>` and `--status <list>` for bulk targeted deletes.

- **`test code get <test-id>` / `test code put <test-id>`** — read the generated test source and replace it with etag-guarded optimistic concurrency (`--expected-version`, or `--force` to skip the guard).

- **`test plan put <test-id>`** — replace a frontend test's plan-steps with a refined plan. Optional `--expected-step-count` drift guard.

- **`project create` / `project update`** — manage projects from the CLI. Both commands pre-flight `--target-url` against local addresses for fast feedback.

- **`test steps <test-id>`** — list a test's run steps with screenshot and DOM-snapshot pointers. `--run-id <id>` filters to the steps of one specific run. Without the flag, returns the cumulative step log across all runs with an advisory when steps span multiple runs.

- **`test result <test-id>`** — latest result: status, started/finished timestamps, video URL, step summary counts (`passed / failed / skipped`), and correlation fields (`snapshotId`, `runId`, `codeVersion`). `--include-analysis` adds an inline root-cause hypothesis, recommended fix target, and failure kind.

- **`test result <test-id> --history`** — list a test's prior runs (newest-first). Filters: `--source cli|portal|mcp|schedule|github_action`, `--since 24h|7d|ISO`, `--page-size`, `--cursor`. Each row carries `runId`, `status`, `source`, `isRerun`, timestamps, `codeVersion`, and `failureKind`. A note is shown in place of a blank table for tests created before run-history tracking began.

- **`test failure get <test-id>`** — the agent entry point. Returns one self-consistent failure bundle: the failing step and its immediate neighbors with screenshots and DOM snapshots, the test source, the video pointer, a root-cause hypothesis, a recommended fix target, and correlation metadata. Every artifact in the bundle shares a single `snapshotId`; the CLI refuses to stitch data from different runs or code versions. `--out <dir>` writes the bundle atomically to disk. `--failed-only` keeps only the failing step and its neighbors.

- **`test failure summary <test-id>`** — one-screen triage card (status, failure kind, root-cause hypothesis, recommended fix target) without downloading media.

- **`test run <test-id>`** — trigger a fresh run. Without `--wait`, prints `{ runId, status: "queued", … }` and exits 0. With `--wait`, polls until terminal; exit 0 on `passed`, exit 1 on `failed | blocked | cancelled`, exit 7 on timeout with a `nextAction` pointing at `test wait <runId>`. Accepts `--target-url`, `--timeout`, `--idempotency-key`.

- **`test run --all --project <id>`** — wave-ordered fresh batch run for all (or filtered) backend tests in a project. Routes to a batch endpoint; response enumerates `accepted[]`, `conflicts[]`, `deferred[]`, `skippedFrontend[]`, and `skippedIntegration[]` so a machine consumer reading `accepted` alone can't silently undercount. `--wait` polls all dispatched run IDs concurrently.

- **`test rerun [test-id…]`** — cheap replay of one or more tests. Frontend reruns replay the saved script verbatim (AI heal-on-drift is **on by default**, opt out with `--no-auto-heal`). Backend reruns expand the producer/teardown dependency closure; use `--skip-dependencies` for just the named test. `--all --project <id>` reruns every test in a project. Returns `accepted[]` plus `deferred[]` for any tests shed by the per-key run-rate limit; under `--wait`, a non-empty `deferred[]` exits 7 with a retry hint.

- **`test wait <run-id>`** — block until a run reaches a terminal status. Resumes polling after a timed-out `test run --wait`, or when an agent already has a `runId`. Uses server-driven long-poll where supported; exponential backoff with `Retry-After` otherwise.

- **`test artifact get <run-id>`** — download the failure bundle for a specific run, addressed by `runId` instead of `testId`. Enforces `meta.runId === <run-id>` as an integrity check; exits 5 on mismatch. Default output directory: `./.testsprite/runs/<run-id>/`.

- **`--dry-run` (global)** — every command runs end-to-end without touching the network, credentials, or the local filesystem; emits canned data matching the API contract.

- **Global flags**: `--profile`, `--output json|text`, `--endpoint-url`, `--request-timeout <seconds>`, `--verbose`, `--debug`.

- **Pagination flags on every list**: `--page-size`, `--starting-token`, `--max-items`.

- **`--debug` HTTP tracing** to stderr (method, URL, request-id, latency, retry decisions). The API key is never included.

- **Dashboard URL in outputs** — commands that know both `projectId` and `testId` include a `dashboardUrl` deep-link to the TestSprite web portal in JSON output. Text mode: create paths print a `Dashboard:` line on stderr; run-completion output (`test run --wait`, `test wait`, `test rerun --wait`, `test run --all`) ends the run card with a `dashboard` line on stdout. The portal domain is resolved from the configured API endpoint per environment.

- **TTY-gated progress ticker** — single-line in-place `\x1b[2K\r` updates during polling on TTY; completely silent on non-TTY (CI) and when `--output json` is set.

- **AWS-CLI-style exit-code taxonomy** — see [Exit codes](#exit-codes) in README.

### Changed

- `blocked` is a distinct top-level status alongside `failed` (was collapsed into `failed` in earlier previews). Triage routes: `blocked` → infra (stale seed, login failure, unreachable target), not bug.

- `test failure get` / `test steps` now synthesize a terminal `assertion` step row when no individual step is in error but the test failed at the assertion or overall-outcome layer. Previously the bundle shipped `steps: []` for these tests. Synthetic rows have no screenshot or DOM snapshot.

- `outcomeContributesToFailure` boolean on every step row (`null` when unclassified). The text renderer prefixes contributing rows with `*` so a 50-step list highlights which rows the failure landed on.

- `failureKind` enum widened: adds `assertion_blocked`, `routing_404`, and `network_timeout` (previously these collapsed into `unknown`). The CLI accepts unrecognized values from the wire as `unknown` so new enum values are non-breaking.

- `recommendedFixTarget` returns `null` (not an `unknown` wrapper) when the analysis pipeline produced no fill. Applied uniformly to `/result?includeAnalysis`, `/failure`, and `/failure summary`.

- `Test.details` debug block ships a structured `processingStatus` / `testStatus` pair alongside the previous `rawStatus` string (deprecated but preserved for the transition window).

- `test create --run/--wait/--timeout/--target-url` fully wired: chains `POST /tests` → `POST /tests/{testId}/runs` → `GET /runs/{runId}` in one invocation. `--target-url` pre-flighted against local addresses on the client (exit 5) before the request is sent.

- Auto-minted idempotency keys and request IDs are suppressed by default; exposed under `--verbose` for retry and support use.

- Per-request wall-clock timeout (`--request-timeout`, default 120 s) applied to every outgoing fetch. Under `--wait`, the per-request timeout is auto-raised to cover `--timeout` + 5 s so a large batch under load is never cut at the default.

- `test run --wait` auto-resumes on 409 `run_in_flight` by polling the existing run instead of exiting 6. An advisory is printed to stderr. Other conflict reasons and body-mismatch conflicts still propagate as exit 6.

- Backend test `test run --wait` / `test rerun --wait` include a fallback path that reads `GET /tests/{id}/result` when the run row is not yet finalized server-side, so the verdict is reachable without waiting for a timeout.

- `test rerun` batch `--wait` summary enumerates `deferred` and `conflicts` counts alongside `total` (dispatched) so machine readers can't silently undercount.

### Fixed

- `parseEnvelopeBody` now recognizes NestJS raw 404 shape, surfacing the original `Cannot POST /api/cli/v1/…` message so the user sees which endpoint isn't deployed on the current backend rather than a generic "Server error." message.

- `test run --wait` CONFLICT auto-resume is gated on `details.reason === 'run_in_flight'` only. When `--target-url` is supplied and the in-flight run's URL differs, the CLI fetches the existing run's URL and reports a descriptive conflict (exit 6) with `nextAction: testsprite test wait <runId>`.

- `test steps` now surfaces the synthetic terminal `assertion` step row for assertion-only failures (previously this row was wired only for `test failure get` and `test failure summary`).

- `test create-batch --plan-from-dir`: the `MAX_BATCH_SPECS` (50) cap is enforced on valid specs after non-plan JSON files are skipped, not on the raw directory entry count. The duplicate-name advisory lookup uses a bounded 5-second deadline so a stalled listing endpoint delays `test create` by at most 5 s.

- `localValidationError` and `ApiError.getDetail<T>()` are shared library helpers; redundant inline cast patterns removed from call sites.

- `engine-strict=true` in `.npmrc` so `npm install` hard-fails on Node < 20 instead of warning and proceeding.

- Commander `help [command]` exits 0 (previously exited 5 on `test help` / `project help`).

[Unreleased]: https://github.com/TestSprite/testsprite-cli/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/TestSprite/testsprite-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/TestSprite/testsprite-cli/releases/tag/v0.1.0
