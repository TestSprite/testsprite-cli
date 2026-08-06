# Changelog

All notable changes to `@testsprite/testsprite-cli` are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-08-05

### Added

- **Command-outcome telemetry — one event per invocation, opt out with one env var.** The CLI now posts a single "how did that command end" event to the TestSprite backend (`POST /api/cli/v1/telemetry`), which forwards it server-side; the CLI ships no analytics SDK and no write key. The payload is a fixed allowlist of low-cardinality fields — the leaf command that ran, `success`/`error`, the exit code, a stable machine `errorCode`, and a duration. It never carries target URLs, API keys, flag values, argument values, or error messages. Opt out with `TESTSPRITE_NO_TELEMETRY` or the cross-tool `DO_NOT_TRACK`. Nothing is sent when no API key is configured, under `--dry-run`, when no leaf command ran (bare `--help`, a parse error), on Ctrl-C, or from the purely local `completion` / `test create --plan-template` paths. The post is bounded at one second and every failure is swallowed: telemetry can never change a command's output, exit code, or duration beyond that bound.
- **`test result --history --rerun` / `--no-rerun`** — narrow run history to only reruns or only fresh runs. Applied client-side on each page's `isRerun` (the backend has no rerun filter), so — exactly like `--source` — a filtered page can come back short or empty while `nextCursor` is still set; paginate to continue. Absent means no filter, never a silent default.
- **`sk-member-` membership keys are accepted.** Workspace membership keys are now minted with an `sk-member-` prefix. The CLI's fail-fast key-format check knew only `sk-user-` and `tsp_`, so it rejected every newly minted membership key locally, before the key ever reached the server. All three families are now accepted from one list that also renders the error message, so the check and the message cannot drift apart; existing `tsp_` keys keep authenticating.
- **`project get` shows the project's target URL.** A backend project created without `--url` is dead on arrival on the V3 execution path (its first run is rejected `no-target-resolvable`), and there was no way to see that from the CLI. `project get` now prints `targetUrl`, and `(not set)` plus the exact `project update … --url` fix-it command when there is none. Absent-safe: against a backend that does not report the field the line is omitted entirely rather than claiming every project is URL-less. `project list` deliberately does not show it — resolving it per row costs one extra read per project.

### Fixed

- **`--wait` no longer fails a healthy V3 backend run.** A V3 run reports `targetUrl: null` (and `codeVersion: null` for a plan-driven frontend case with no code row), which the response validator rejected — so `test create --run --wait` and `test wait` printed `INTERNAL: Response shape mismatch` _after_ the run had already dispatched. The wire contract always allowed null on those fields; the CLI was the side out of spec.
- **A rate limit no longer ends a multi-run `test wait`.** With several run ids, one 429 from the backend's IP-keyed limiter (which a CI runner or NAT can trip through no fault of the key) recorded that member as a poll error and exited 7 — reporting a healthy run as a failure to observe it. Each member now re-polls up to 3 times honoring the server's `Retry-After`; every backoff is clamped to the shared `--timeout` deadline, stays interruptible by Ctrl-C, and reports a timeout rather than a rate limit if the deadline is reached during one. When a throttle outlasts the retry budget **and** nothing else went wrong, the exit code is 11 (rate limited — back off, then re-attach) instead of 7, which told an automated caller to retry immediately and walk straight back into the limiter. Any real timeout or non-passed run in the same invocation still exits 7 / 1.
- **`usage` reports the wallet that actually pays for your runs.** On an organization-billed account the spend drains the workspace wallet, so the legacy per-user balance was a number that never moved. When the backend reports an active organization, `usage` renders the workspace block (plan, remaining, per-seat allowance, seats) and suppresses the legacy balance; `auth status` gains a one-line `org:` summary. The `~N runs` estimate stays on the legacy path — workspace billing prices each action separately, so there is no single per-run rate.
- **`--no-auto-heal` was a silent no-op on rerun, and `test flaky` never disabled healing at all.** The rerun request body omitted `autoHeal` entirely when you opted out, and the server treats an absent field as heal-on — so the opt-out did nothing, and `test flaky`'s strict verbatim replays (whose whole point is that a nondeterministic pass cannot be masked by a heal) were quietly healing too. All three rerun dispatch sites now send an explicit boolean, `test flaky` always sends `autoHeal: false`, and `--dry-run` previews the same body the real request sends. Rerun and batch-rerun responses may also carry advisories now (e.g. an engine that does not yet honor the opt-out); each renders as one `[advisory]` line on stderr, deduped across batch chunks, deferred retries, and flaky probes.
- **One closure member's poll error no longer discards a whole backend `test rerun --wait`.** A backend rerun expands its dependency closure server-side and polls every member. A single member's non-timeout poll error (an API error, a transient failure, a malformed response) rejected the entire fan-out, throwing away the sibling results **and** the named test's own verdict. Classifiable member errors now land in `closureFailures[]` and the named test still prints its result; its own error, if any, is re-thrown after the payload. Any unobserved member — timed out or poll-errored — still forces exit 7, so `--wait` never reports success with an unconfirmed dependency.
- **Run cards use the server's dashboard link when it offers one.** `GET /runs/{runId}` may now carry a server-built `dashboardUrl`, and the run-completion paths prefer it over the link this process templates. Two things the server knows and the CLI cannot: which store answered the read (a project created through the V3-native write path has no row behind the route the CLI templates, so its link could not render at all), and the portal origin outside production (against any non-prod endpoint the CLI printed no link whatsoever). An absent field reopens the client computation, so an older backend behaves exactly as before. Separately, a `dashboardUrl: null` on the wire no longer fails response validation and kills `test wait` — the same trap that had to be un-sprung for a null `targetUrl`.

### Changed

- **`auth status` and `doctor` explain a workspace you cannot reach.** An API key belongs to exactly one workspace, chosen when it is minted. Someone in a team using a personal key previously just saw the team's projects missing from `project list`, and addressing one by id failed the same way a typo does. Both commands now name the unreachable workspaces and point at minting a key there. Silent for solo users and for keys that are already workspace-bound.
- **The V3 routing advisory only lists gaps that are still open.** It claimed `test cancel` could 404 and `test delete` could leave a zombie run; both have shipped. It now names the two real ones: `--target-url` is ignored on frontend runs, and a frontend rerun replays the run it was pointed at rather than the latest saved code.

## [0.4.0] - 2026-07-16

### Added

- **`test cancel <run-id...>`** — user-initiated cancel of in-flight runs (the real stop button; Ctrl-C only detaches). A single id renders the run card with status `cancelled` (plus an advisory when it was already cancelled); multiple ids print a `{cancelled, alreadyCancelled, conflicts, notFound}` summary. Exit codes: 4 when any id is not found, else 6 on conflicts, else 0. `--dry-run` supported.
- **Graceful Ctrl-C during `--wait`** — SIGINT/SIGTERM now detaches cleanly instead of killing the process mid-poll: the in-flight request aborts immediately, stdout gets the same partial `{runId, status: "running"}` envelope as the request-timeout path, and stderr states the truth — the server-side run keeps executing (and billing) — with a re-attach hint and a `test cancel` pointer. Exit 130/143/129 per the documented signal contract; a second signal forces a hard exit. Interrupting never cancels the server-side run — that's what `test cancel` is for.
- **`project delete <project-id> --confirm`** — permanently delete a project and everything under it (its frontend/backend sub-projects, all their tests, and backend fixtures), mirroring the Portal's cascade delete. Requires `--confirm` (the CLI never prompts); `--dry-run` previews the response shape without a network call. Standard exit codes: 0 success, 3 auth, 4 not-found (or already-deleted), 5 validation (e.g. missing `--confirm`).
- **Backend stdout and traceback in results** — `test result` and the failure bundle now surface the backend test's captured stdout and Python traceback: full content in `--output json` (and in `result.json` / `failure.json` bundle files), and a bounded 20-line tail with a byte count in text mode. No change for frontend tests, passing runs, or older backends.
- **Backend dependency declarations are now readable and editable** — `test get` surfaces `produces` / `consumes` / `category`, and `test update` accepts `--produces` / `--needs` / `--category` (previously create-only).
- **Version-compatibility handshake** — the CLI reads the backend's advertised minimum-supported-version on every response and prints a one-line upgrade advisory on stderr when the running version is below the floor (honors the same opt-outs as the update notice; never alters exit status). A `CLIENT_TOO_OLD` rejection (HTTP 426) is now a first-class error: exit 14, non-retriable, rendered with upgrade guidance and the version gap.
- **V3 routing visibility** — `auth status` and `doctor` render a `routing: v2|v3` line when the backend reports the account's routing, and V3-routed accounts get one consolidated advisory listing the known V3-path behavior gaps. Text mode only — JSON consumers read `v3Enabled` from the `/me` payload; absent-safe against older backends.

### Changed

- **The `testsprite-verify` agent skill routes local-only changes to the TestSprite MCP** — the skill now states the reachability gate explicitly: the CLI verifies reachable deployed URLs only; when the change is only running locally, the skill hands off to the TestSprite MCP when available (an explicitly named tool always wins), instead of failing against localhost.

### Fixed

- **`project create --description` now fails fast with a clear validation error** — projects have no description field, so the flag's value was previously dropped silently; the error points at test-level descriptions (`test create --description`) instead.
- **Standalone backend run cards no longer show a misleading step summary** — `test run` / `test wait` / `test rerun` cards for backend tests render `steps: n/a (backend)` instead of `0/0 (passed=0, failed=0)` (backend tests have no per-step storage).

## [0.3.0] - 2026-07-08

### Added

- **`testsprite doctor`** — one-command environment diagnostic that checks your Node version, credentials, endpoint reachability, and installed agent skills, and reports what's misconfigured.
- **`test scaffold`** — emit a schema-correct starter plan (frontend) or a backend test skeleton to bootstrap a new test without hand-writing the JSON.
- **`test lint`** — offline validator for plan / steps files; catches malformed test definitions before they are sent to the server.
- **`test diff <run-a> <run-b>`** — compare two runs of the same test to isolate what changed between a passing and a failing run.
- **`test flaky <test-id>`** — repeat-run flaky-test detector. Replays a test N times (`--runs`, default 5), aggregates the outcomes, and reports a stability verdict (`stable` / `flaky` / `failing`) plus the `runId` and `failureKind` of every attempt that did not pass. Replays run with auto-heal off (strict verbatim) so a nondeterministic pass/fail can't be masked. Exit code is 0 only when every attempt passed, so CI can gate a merge on flakiness. Flags: `--runs` (1–10), `--until-fail`, `--timeout`, `--output json`.
- **JUnit XML report export for batch runs.** `test run --all` and batch `test rerun` accept `--report junit --report-file <path>` to write a CI-friendly XML sidecar after `--wait` polling completes. The report is written even when the batch exits non-zero; `--output json` is unchanged; `--dry-run` writes a canned sample without network calls.
- **`test wait` is now variadic** — pass several run ids to attach to and poll multiple runs in a single invocation.
- **`agent status`** — report which TestSprite skills are installed for each agent target and whether they are current; installed skills are now stamped with a version/hash marker.
- **New `agent install` targets:** GitHub Copilot, Windsurf, and Kiro (experimental), alongside the existing Claude / Cursor / Cline / Codex / Antigravity targets.
- **`project credential` / `project auto-auth`** — configure a project's backend credentials (static credential, free) or a recurring auto-auth token (Pro) from the CLI, with surfaced auth warnings and managed-credential guidance.
- **Proxy support** — the CLI now honors `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` for use behind corporate and CI proxies.
- **`NO_COLOR` support** — colored output is suppressed when `NO_COLOR` is set, per no-color.org.
- **"New version available" notice** — a non-blocking, 24h-cached npm version check prints an upgrade hint on stderr. Opt out with the documented env var; automatically silenced in CI and under `--output json`.

### Changed

- **Node.js 20.19+, 22.13+, or 24+ is now the minimum supported runtime.** The CLI checks the running Node version at startup and exits with a clear message on an unsupported version; builds and CI run against Node 20 and 22.
- **Graceful shutdown** — the CLI handles termination signals cleanly and guards against broken-pipe (`EPIPE`) errors when its output is piped to a closing consumer (e.g. `| head`).
- **Interactive prompts and preamble now go to stderr**, keeping stdout pure for machine consumers even in interactive mode.
- **Empty environment variables are treated as unset** when resolving config, so `TESTSPRITE_API_URL=` no longer overrides the built-in default with an empty string.
- `agent install` defaults `--target` to `claude` in non-interactive / CI contexts (matching `setup`).
- The `usage` command no longer implies backend test runs are free.
- `setup`'s "Next steps" guidance no longer suggests `test list` before any project exists.

### Fixed

- **Timeouts & polling:** `RequestTimeoutError` is now classified as a timeout in the `--all --wait` fan-out; per-attempt timeout timers are cleared so they can't fire late; `run --all --wait` no longer polls still-queued runs past the shared deadline; a partial result is emitted on stdout when `run --wait` / `test wait` times out (so a redirected file is never zero-byte).
- **Batch rerun:** the exit code is preserved and auth errors escalate correctly; explicit ids combined with `--all` — or `--status` / `--skip-terminal` without `--all` — are rejected with a clear validation error; auto-minted idempotency keys are surfaced under `--output json`.
- **HTTP:** non-JSON `200` responses map to a typed error envelope instead of crashing the parser.
- **Failure bundles / artifacts:** artifact downloads retry on transient errors and guard the default run-id path; the `--out` directory no longer sweeps unrelated pre-existing files (data-loss fix); run-scoped per-step error text and step type are surfaced.
- **Input validation (fail fast, before any network call):** malformed API keys, invalid `--request-timeout`, directory `--code-file` / `--out` paths, blank or whitespace-only `--name` (test and project create/update), blank inline project passwords, fractional pagination flags / page sizes, and `--since` overflow are all rejected up front with `VALIDATION_ERROR` rather than crashing or failing late server-side. `--output` is validated uniformly across all command groups.
- **Setup / auth:** the endpoint is validated before the key check; the typed API-error envelope is preserved when key verification fails; the per-request timeout is honored during `configure`.
- **Misc:** cursor pagination no longer drops empty pages; trailing-dot hostnames are treated as loopback by the local-target guard; buffered input is preserved between interactive prompts; the Codex managed-section skill check requires a complete section; `code get` strips a leading BOM and rejects an empty `--out`.

### Security

- **INI injection:** CR/LF characters are stripped from credential values before they are written to `~/.testsprite/credentials`.
- **Symlink fail-close:** the own-file `agent install` path applies its symlink containment guard under `--dry-run` as well, so a planted symlink cannot place or clobber files outside `--dir`.

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

[Unreleased]: https://github.com/TestSprite/testsprite-cli/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/TestSprite/testsprite-cli/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/TestSprite/testsprite-cli/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/TestSprite/testsprite-cli/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/TestSprite/testsprite-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/TestSprite/testsprite-cli/releases/tag/v0.1.0
