# `testsprite` CLI — Documentation

The full reference for the TestSprite CLI: install verification, manual setup, every command with examples, configuration, scripting, and exit codes.

> Looking for the quick tour? Start with the [README](./README.md).
> This reference will progressively move to [docs.testsprite.com](https://www.testsprite.com/docs); this file is the source of truth until then.

## Contents

- [Install & verify](#install--verify)
- [Manual setup](#manual-setup)
- [The complete agent loop](#the-complete-agent-loop)
- [Agent onboarding (`agent install`)](#agent-onboarding-agent-install)
- [Command reference](#command-reference)
  - [Read commands](#read-commands)
  - [Write commands](#write-commands)
  - [Run commands](#run-commands)
  - [Account & diagnostics](#account--diagnostics)
- [Configuration](#configuration)
- [Output & scripting](#output--scripting)
- [Exit codes](#exit-codes)
- [Design principles](#design-principles)

---

## Install & verify

```bash
npm install -g @testsprite/testsprite-cli
testsprite --version
```

Or run it without installing:

```bash
npx @testsprite/testsprite-cli --version
```

Requires **Node.js 20.19+**, **22.13+**, or **24+**.

Confirm the binary works **without** configuring an API key:

```bash
testsprite --version
testsprite project list --dry-run --output json
```

`--dry-run` is a global flag that skips the network, credentials, and the local filesystem and emits a canned sample matching the API contract. It's the right way to confirm an install or learn the surface before configuring auth — the response _shapes_ match the wire contract, but the data is fake.

## Manual setup

The recommended path is `testsprite setup` (see the [README quickstart](./README.md#quickstart)). If you prefer to configure each step separately:

### 1. Authenticate

The CLI uses API keys. Create one from your [TestSprite dashboard](https://www.testsprite.com), then configure it:

```bash
# Interactive — prompts for your API key (input is masked); endpoint defaults to prod
testsprite auth configure

# Non-interactive — reads TESTSPRITE_API_KEY from the environment (CI / scripts)
TESTSPRITE_API_KEY=sk-... testsprite auth configure --from-env

# Verify
testsprite auth whoami
```

Credentials are stored at `~/.testsprite/credentials` (INI-style, mode `0600`). See [Configuration](#configuration) for profiles, environment overrides, and scopes.

### 2. Run your first test

```bash
# Describe a behavior, trigger it, and wait for a verdict — in one call
testsprite test create \
  --project proj_xxxxxxxx --type frontend \
  --plan-from ./checkout.plan.json \
  --run --wait --timeout 600 --output json
```

Exit `0` means the run passed; exit `1` means it failed. When it fails, pull the bundle (next section).

## The complete agent loop

This is the loop a coding agent runs on its own once you've onboarded it with `testsprite agent install`:

```bash
# (one-time, per project) teach your agent the CLI
testsprite agent install claude

# 1 — describe the behavior you want to guarantee, run it, wait
testsprite test create --project proj_8f0f6 --type frontend \
  --plan-from ./checkout-flow.plan.json --run --wait --output json
#   → exits 1: the run failed

# 2 — pull ONE self-consistent failure bundle to ./.testsprite/failure/
#     (code + failing step + screenshots + DOM + root-cause + recommended fix)
testsprite test failure get test_3a9f21c7 --out ./.testsprite/failure

# 3 — the agent reads the bundle, edits the code, redeploys, then replays
testsprite test rerun test_3a9f21c7 --wait --output json
#   → exits 0: passed. The test now lives in your durable suite.
```

Every artifact in the bundle shares one `snapshotId`; the CLI will not mix a failing step from one run with source code from another. Run any command with `--dry-run` first to learn its on-disk shape with zero setup.

## Agent onboarding (`agent install`)

`testsprite agent install` writes a ready-made skill/instruction file into your project so your coding agent knows the commands, the exit codes, and the failure-bundle layout — no prompt engineering required. It's a pure-local command: no network, no credentials.

```bash
testsprite agent install claude     # install the skill for Claude Code
testsprite agent install codex      # install into AGENTS.md for Codex (managed-section)
testsprite agent install cursor     # .cursor/rules/testsprite-verify.mdc
testsprite agent install cline      # .clinerules/testsprite-verify.md
testsprite agent install windsurf   # .windsurf/rules/testsprite-verify.md
testsprite agent install antigravity  # .agents/skills/testsprite-verify/SKILL.md
testsprite agent install kiro       # .kiro/skills/testsprite-verify/SKILL.md
testsprite agent install copilot    # .github/instructions/testsprite-verify.instructions.md
testsprite agent list               # list all 8 targets with status + mode + path
testsprite agent status             # check installed skills against this CLI version
```

Supported targets: `claude` (GA), `codex` (experimental), `cursor` (experimental), `cline` (experimental), `antigravity` (experimental), `kiro` (experimental), `windsurf` (experimental), `copilot` (experimental).

Omitting `--target` in a non-interactive shell (CI, agent subprocess) defaults to `claude` with an `[info]` note on stderr; in a terminal the CLI prompts (empty answer = `claude`).

`agent status` checks every installed skill file against the current CLI version and reports one of `ok`, `stale`, `modified`, `unmarked`, `absent`, or `corrupt` per target. It exits `1` when anything needs attention, so `testsprite agent status && …` can gate a CI step; `--dir <path>` inspects a different project root.

The `codex` target uses **managed-section mode** — it writes only a sentinel-delimited section inside your existing `AGENTS.md`, so your project instructions are never clobbered. Re-running without `--force` replaces the section in-place; user content outside the sentinels is always preserved.

Re-running with `--force` on **own-file targets** (claude, cursor, cline, antigravity, kiro, windsurf, copilot) backs up the existing file to `<path>.bak` first.

## Command reference

Every command supports the [global flags](#global-flags), and every example below pairs a real call with a `--dry-run` companion that works on a fresh install with no auth.

### Read commands

#### `testsprite project list`

List the projects visible to your API key. Cursor-paginated.

```bash
testsprite project list --output json
testsprite project list --dry-run --output json
```

Common flags:

- `--page-size <n>` — server hint for items per page; the cursor token comes back in `nextToken`. Passing `--page-size` without `--max-items` returns a single page.
- `--starting-token <token>` — opaque cursor from a previous response.
- `--max-items <n>` — client-side cap on total items across auto-paged pages.

#### `testsprite project get <project-id>`

Get a single project by id. Project ids look like `proj_xxxxxxxx` and come from `project list`.

```bash
testsprite project get proj_xxxxxxxx --output json
testsprite project get proj_xxxxxxxx --dry-run --output json
```

#### `testsprite test list --project <id>`

List tests under a project. `--project` is required. Cursor-paginated.

```bash
testsprite test list --project proj_xxxxxxxx --output json
testsprite test list --project proj_xxxxxxxx --type frontend --created-from portal
testsprite test list --project proj_xxxxxxxx --dry-run --output json
```

Common flags:

- `--type <frontend|backend>` — filter by test type.
- `--created-from <portal|mcp>` — filter by where the test was authored.
- `--status <list>` — filter by status.
- `--page-size`, `--starting-token`, `--max-items` — pagination, same shape as `project list`.

#### `testsprite test get <test-id>`

Get a single test by id. Test ids look like `test_xxxxxxxx` and come from `test list`.

```bash
testsprite test get test_xxxxxxxx --output json
testsprite test get test_xxxxxxxx --dry-run --output json
```

#### `testsprite test code get <test-id>`

Print the generated test source. TestSprite test code is **Python**: frontend tests are Playwright (`playwright.async_api`, async), backend tests use `requests` with `pytest`-style assertions. With `--out <path>`, write it to a file instead of stdout (text mode writes the source body; JSON mode writes the wire envelope).

```bash
testsprite test code get test_xxxxxxxx
testsprite test code get test_xxxxxxxx --out ./test_xxxxxxxx.py
testsprite test code get test_xxxxxxxx --dry-run --output json
```

#### `testsprite test steps <test-id>`

List the latest steps for a test (with screenshot / DOM-snapshot pointers). Auto-paginates by default.

```bash
testsprite test steps test_xxxxxxxx --output json
testsprite test steps test_xxxxxxxx --dry-run --output json
```

Common flags: `--page-size`, `--starting-token`, `--max-items` — same shape as the other lists.

#### `testsprite test result <test-id>`

Get the latest result for a test — status, started / finished timestamps, video and failure-analysis URLs, summary counts (`passed / failed / skipped`), and correlation fields (`snapshotId`, `runId`, `codeVersion`). With `--include-analysis`, the response also carries an inline `analysis` block (root-cause hypothesis, recommended fix target, failure kind).

```bash
testsprite test result test_xxxxxxxx --output json
testsprite test result test_xxxxxxxx --include-analysis --output json
testsprite test result test_xxxxxxxx --dry-run --output json
```

With `--history`, the command lists a test's **prior runs** instead of the latest result — `{ runs: [...], nextCursor }`, where each run carries `runId`, `status`, `source` (`cli | portal | mcp | schedule | github_action`), `isRerun`, `createdFrom`, timestamps, `codeVersion`, and `failureKind`. Filter with `--source <src>` and `--since <24h|7d|ISO>`; paginate with `--page-size` (1–100, default 20) and `--cursor`. For one run's detail use `test wait <run-id>`; for its failure bundle use `test artifact get <run-id>`.

```bash
testsprite test result test_xxxxxxxx --history --output json
testsprite test result test_xxxxxxxx --history --source cli --since 7d --output json
testsprite test result test_xxxxxxxx --history --dry-run --output json
```

#### `testsprite test diff <run-a> <run-b>`

Compare two runs of a test and print what regressed: verdict, `failureKind`, `failedStepIndex`, per-step status flips, and `codeVersion` drift. Exit `0` when the verdicts match, `1` when they differ — so a script can assert "this rerun behaves like the last known-good run" in one call.

```bash
testsprite test diff run_aaaa run_bbbb --output json
testsprite test diff run_aaaa run_bbbb --dry-run --output json
```

#### `testsprite test failure get <test-id>`

The latest-failure agent entry point. Returns one consistent snapshot of the latest failing run as a self-contained bundle: the result, the failed step plus its immediate neighbors with screenshots and DOM snapshots, the test source, a video pointer, a root-cause hypothesis, a recommended fix target, and correlation metadata. For the bundle of a _specific_ run an agent just triggered, prefer `test artifact get <run-id>` — it is keyed by `runId` and cannot be raced by another run that lands afterward.

```bash
# Print the wire envelope to stdout (good for piping into jq or an LLM)
testsprite test failure get test_xxxxxxxx --output json

# Write the bundle as a directory under --out (atomic; .partial marker on crash)
testsprite test failure get test_xxxxxxxx --out ./.testsprite/failure/test_xxxxxxxx

# Keep only the failed step plus its immediate neighbors (±1)
testsprite test failure get test_xxxxxxxx --out ./fail --failed-only

# Dry-run prints the canned wire envelope; with --out it prints what would be
# written (no directory is created)
testsprite test failure get test_xxxxxxxx --dry-run --output json
testsprite test failure get test_xxxxxxxx --dry-run --out ./fail
```

Every artifact in the bundle shares one `snapshotId`; the CLI refuses to stitch data from different runs or code versions. Run `--dry-run` once to learn the on-disk shape, then run it for real.

#### `testsprite test failure summary <test-id>`

One-screen agent-friendly triage card (status, failure kind, root-cause hypothesis, recommended fix target) without downloading video, screenshots, or DOM snapshots. Sibling of `test failure get` — useful when an agent only needs to decide _what kind_ of failure it is looking at.

```bash
testsprite test failure summary test_xxxxxxxx --output json
testsprite test failure summary test_xxxxxxxx --dry-run --output json
```

### Write commands

Require the `write:tests` scope (project commands require `write:projects`), except `test scaffold` and `test lint`, which are pure-local authoring helpers — no network, no credentials, no scope.

#### `testsprite test scaffold`

Emit a schema-correct starter test definition — a frontend plan JSON by default, or a backend Python skeleton with `--type backend`. Pure-local: no network, no credentials. Edit the scaffold, then create the test with `--plan-from` / `--code-file`.

```bash
testsprite test scaffold > first-test.plan.json
testsprite test scaffold --type backend --out tests/health.py
testsprite test scaffold --out plan.json --force     # overwrite an existing file
```

#### `testsprite test lint`

Validate plan/steps files offline with the same validators `test create` runs, collecting **every** problem instead of stopping at the first. No network, no credentials. Exit `0` when all inputs are valid, `5` otherwise.

```bash
testsprite test lint --plan-from ./checkout.plan.json
testsprite test lint --plan-from-dir ./plans/          # every *.json checked, all errors reported
testsprite test lint --plans ./plans.jsonl             # one plan spec per line
testsprite test lint --steps ./refined.plan.json       # the shape `test plan put` ingests
```

#### `testsprite test create`

Create a new test. Backend tests use `--code-file` (agents supply backend code directly); frontend tests use either `--code-file` or `--plan-from`. With `--run --wait`, the CLI chains create → trigger → poll in a single invocation.

```bash
# Backend test from a code file
testsprite test create --project proj_xxxxxxxx --type backend --name "Login API" \
  --code-file ./login.py

# Frontend test from an agent-supplied plan-steps document; trigger + wait inline
testsprite test create --plan-from ./checkout.plan.json --type frontend \
  --run --wait --timeout 600 --output json

# Dry-run prints the canned wire envelope
testsprite test create --plan-from ./checkout.plan.json --dry-run --output json
```

#### `testsprite test create-batch`

Bulk-create frontend tests from a JSONL plan-steps file (or a directory of plan files with `--plan-from-dir`). Optional `--run --max-concurrency <N>` fans out triggers.

```bash
testsprite test create-batch --plans ./plans.jsonl --run --max-concurrency 4 --output json
testsprite test create-batch --plan-from-dir ./plans/ --dry-run --output json
```

#### `testsprite test update <test-id>`

Update test metadata (name, description).

```bash
testsprite test update test_xxxxxxxx --name "Renamed test" --description "Updated"
testsprite test update test_xxxxxxxx --dry-run --output json
```

#### `testsprite test delete <test-id>` / `test delete-batch`

Permanently delete one test (or many) — there is **no restore window**. `--confirm` is required; absent it, the CLI exits 5 with a local validation error.

```bash
testsprite test delete test_xxxxxxxx --confirm
testsprite test delete-batch test_aaaa test_bbbb --confirm
testsprite test delete-batch --all --project proj_xxxxxxxx --confirm
testsprite test delete test_xxxxxxxx --dry-run --output json
```

#### `testsprite test code put <test-id>`

Replace the generated test code with a new file. **The replacement must be Python** — the execution engine runs the stored code with Python `exec()` (frontend: Playwright `playwright.async_api`; backend: `requests` + assertions), so a TypeScript/JavaScript file would fail at run time with a `SyntaxError`. The CLI uses an etag (`codeVersion`) for optimistic-concurrency control: it auto-fetches the current version, or pass `--expected-version` to pin one, or `--force` to skip the guard.

```bash
testsprite test code put test_xxxxxxxx --code-file ./test.py
testsprite test code put test_xxxxxxxx --code-file ./test.py --expected-version v3
testsprite test code put test_xxxxxxxx --code-file ./test.py --dry-run --output json
```

#### `testsprite test plan put <test-id>`

Replace a frontend test's plan-steps with a refined plan. `--expected-step-count` is an optional drift guard.

```bash
testsprite test plan put test_xxxxxxxx --steps ./refined.plan.json --expected-step-count 8
testsprite test plan put test_xxxxxxxx --steps ./refined.plan.json --dry-run --output json
```

#### `testsprite project create` / `project update`

Manage projects from the CLI. Both pre-flight `--url` against local addresses for fast feedback. Note the asymmetry: `--description` is **create-only** — `project update` accepts `--name`, `--url`, `--username`, `--password`, `--password-file`, and `--instruction`, but not `--description`.

```bash
testsprite project create --type frontend --name "Checkout" --url https://staging.example.com
testsprite project update proj_xxxxxxxx --name "Checkout v2"
```

#### `testsprite project credential <project-id>`

Set the **static backend credential** injected into every backend test in the project (free tier). Supported types: `public` (no credential), `"Bearer token"`, `"API key"`, `"basic token"`.

```bash
testsprite project credential proj_xxxxxxxx --type "Bearer token" --credential-file ./token.txt
testsprite project credential proj_xxxxxxxx --type public
testsprite project credential proj_xxxxxxxx --type "API key" --credential sk-live-... --dry-run --output json
```

`--credential <value>` or `--credential-file <path>` supplies the value (required unless `--type public`). Prefer `--credential-file` in scripts so the secret never lands in shell history.

#### `testsprite project auto-auth <project-id>`

Configure the **recurring-token (auto-refresh) login** for backend tests (Pro): a fresh token is fetched on each run and injected into every backend test, so long-lived suites survive token expiry.

```bash
# Password login: POST the login endpoint, extract the token, inject as a Bearer header
testsprite project auto-auth proj_xxxxxxxx \
  --method password --inject bearer \
  --login-url https://api.example.com/login --login-method POST \
  --login-content-type application/json \
  --login-body-template '{"user":"{{username}}","pass":"{{password}}"}' \
  --username ci@example.com --password-file ./pw.txt \
  --token-path '$.data.accessToken'

# OAuth refresh-token flow
testsprite project auto-auth proj_xxxxxxxx \
  --method refresh_token --inject header --inject-key X-Auth-Token \
  --token-endpoint https://auth.example.com/oauth/token \
  --client-id my-client --client-secret-file ./secret.txt \
  --refresh-token-file ./refresh.txt --scope api.read

# AWS Cognito refresh
testsprite project auto-auth proj_xxxxxxxx \
  --method aws_cognito_refresh --inject bearer \
  --client-id my-app-client --refresh-token-file ./refresh.txt --region us-east-1

# Turn it off (stored config is kept)
testsprite project auto-auth proj_xxxxxxxx --disable
```

Required flags: `--method <password|refresh_token|aws_cognito_refresh>` and `--inject <bearer|header|cookie>` (`--inject-key <name>` names the header/cookie when not `bearer`). Method-specific flags: password login uses `--login-url/--login-method/--login-content-type/--login-body-template/--username/--password[-file]/--token-path`; OAuth uses `--token-endpoint/--client-id/--client-secret[-file]/--refresh-token[-file]/--scope`; Cognito adds `--region`. File variants (`--password-file`, `--client-secret-file`, `--refresh-token-file`) keep secrets out of shell history.

### Run commands

Require the `run:tests` scope.

#### `testsprite test run <test-id>`

Trigger a run for a test. Without `--wait`, prints `{ runId, status: "queued", enqueuedAt, codeVersion, targetUrl }` and exits 0. With `--wait`, polls until terminal — exit 0 on `passed`, exit 1 on `failed | blocked | cancelled`, exit 7 on `--timeout`. On a timeout the CLI still prints the partial run object (with `runId`) to stdout **before** exiting 7, plus a `nextAction` pointing at `test wait <run-id>` — so a script always has the id to resume with, and stdout is never empty.

`--all --project <id>` runs every test in the project in wave order. On the current unified engine that means **all tests, frontend and backend**; on the legacy backend-only engine, frontend tests can't run — they are skipped and enumerated in `skippedFrontend` with a stderr advisory.

```bash
# Trigger and return immediately
testsprite test run test_xxxxxxxx --output json

# Trigger against an environment URL and wait for terminal status
testsprite test run test_xxxxxxxx --target-url https://staging.example.com \
  --wait --timeout 600 --output json

# Dry-run prints a canned queued response (no network, no credentials)
testsprite test run test_xxxxxxxx --dry-run --output json

# Batch run with JUnit XML for CI (sidecar; --output json unchanged)
testsprite test run --all --project proj_xxxxxxxx --wait \
  --report junit --report-file ./results.xml --output json

# Optional custom suite name (default: testsprite:<projectId>)
testsprite test run --all --project proj_xxxxxxxx --wait \
  --report junit --report-file ./results.xml --report-suite-name my-ci-suite --output json
```

Batch `--report` flags apply only to `test run --all --wait` (and batch `test rerun --wait`). `--report junit --report-file <path>` writes a JUnit XML sidecar after polling completes (atomic write); `--output json` is unchanged. Optional `--report-suite-name <name>` overrides the default `testsprite:<projectId>` suite name.

`--target-url` must be a publicly reachable URL — the CLI pre-flights it against local addresses (`localhost`, `127.x`, `::1`, `0.0.0.0`, `169.254.x`, RFC1918) and the backend resolves it via DNS. For testing against localhost, use the [TestSprite MCP plugin](https://www.testsprite.com/docs), which handles the local tunnel. The CLI auto-mints an idempotency key (printed to stderr under `--output json`, `--verbose`, or `--debug`); pass `--idempotency-key <uuid>` to control it explicitly.

#### `testsprite test rerun [test-id...]`

Re-execute one or more tests as a cheap **replay** — distinct from `test run`, which triggers a fresh agent run that may regenerate code and spend credits. A frontend rerun replays the saved script (verbatim unless AI heal-on-drift engages — see `--auto-heal`); a backend rerun re-runs the named test together with its producer/teardown dependency closure. Without `--wait`, prints the queued run(s) and exits 0; with `--wait`, polls to terminal with the same exit-code matrix as `test run --wait`.

```bash
# Frontend test — verbatim replay
testsprite test rerun test_xxxxxxxx --wait --output json

# Backend test — reruns the dependency closure (producers + teardowns)
testsprite test rerun test_be_xxxx --wait --output json

# Backend test — just the named test, skip the closure
testsprite test rerun test_be_xxxx --skip-dependencies --output json

# Rerun every test in a project (batch)
testsprite test rerun --all --project proj_xxxxxxxx --wait --max-concurrency 4 --output json

# Batch rerun with JUnit XML for CI
testsprite test rerun --all --project proj_xxxxxxxx --wait \
  --report junit --report-file ./results.xml --output json

# Optional custom suite name (default: testsprite:<projectId>)
testsprite test rerun --all --project proj_xxxxxxxx --wait \
  --report junit --report-file ./results.xml --report-suite-name my-ci-suite --output json

# Several specific tests
testsprite test rerun test_aaaa test_bbbb --wait --output json
```

Batch `--report` flags apply only to batch `--wait` reruns (`--all` or multiple test ids). `--report junit --report-file <path>` writes a JUnit XML sidecar after polling completes (atomic write); `--output json` is unchanged. When `--project` is omitted, the CLI infers `projectId` from polled run rows for classname / default suite naming; if inference fails, pass `--project <id>` explicitly (required under `--dry-run`).

Flags:

- `--all` — rerun every test in the resolved project; requires `--project <id>`.
- `--wait`, `--timeout <s>` — block until terminal; same exit matrix as `test run --wait`.
- `--auto-heal` / `--no-auto-heal` — frontend AI heal-on-drift, **on by default** for FE reruns; opt out with `--no-auto-heal`. Verbatim-replay passes are free; a heal engage costs a small amount of credit. Ignored for backend tests.
- `--skip-dependencies` — backend only: rerun just the named test without expanding the producer/teardown closure.
- `--max-concurrency <n>` — with `--wait`, cap on in-flight polls during a batch rerun.
- `--idempotency-key <key>` — auto-minted when omitted (the minted key is printed to stderr under `--output json`, `--verbose`, or `--debug`).
- `--report junit --report-file <path>` — with batch `--wait`, write a JUnit XML sidecar after polling (atomic write). Optional `--report-suite-name <name>` overrides the default `testsprite:<projectId>` suite name. Requires `--wait`; not available on single-test reruns.

A batch rerun returns `accepted[]` (one `runId` per dispatched test) plus `deferred[]` for any test shed by the per-key run-rate limit; under `--wait`, a non-empty `deferred[]` exits 7 with a `nextAction` you can retry with a fresh idempotency key.

#### `testsprite test flaky <test-id>`

Detect a **flaky** test by replaying it several times and reporting how often it passes. Each attempt is a rerun with auto-heal **off** (a strict verbatim replay), so healed drift can't disguise a nondeterministic pass/fail — this measures the replay stability of the saved script against the configured URL. Frontend replays are free verbatim script replays; backend tests re-run their dependency closure and may cost credits (a one-line stderr advisory is printed before the run).

```bash
# Replay 10 times and print a stability score
testsprite test flaky test_xxxxxxxx --runs 10

# Fast "is it flaky at all?" — stop at the first non-passing attempt
testsprite test flaky test_xxxxxxxx --runs 10 --until-fail

# Machine-readable stability report for CI
testsprite test flaky test_xxxxxxxx --runs 10 --output json
```

Flags:

- `--runs <n>` — number of replays (1–10, default 5).
- `--until-fail` — stop at the first attempt that does not pass.
- `--timeout <s>` — per-attempt polling deadline (same semantics as `test wait`).

`--output json` emits `{ testId, runs, passed, failed, stableRatio, verdict, failures: [{ attempt, runId, outcome, failureKind }] }`. Exit codes: **0** when every observed attempt passed (`stable`); **1** when any attempt did not pass (`flaky` or `failing`); **4** when the test has no replayable run (trigger `testsprite test run <id>` first); **5** on a validation error.

#### `testsprite test wait <run-id...>`

Block until one **or more** runs reach a terminal status. With a single `run-id` the behavior is unchanged: same exit-code matrix as `test run --wait`. With several ids, the runs are polled concurrently under one shared `--timeout` and the CLI prints a `{ results, summary }` envelope — the worst status wins the exit code — so every re-attach hint the CLI prints can be pasted back as one command. `--max-concurrency <n>` (1–100, default 10) caps concurrent polls. Used to resume polling after a timed-out `--wait`, or when an agent already holds `runId`s from previous invocations.

```bash
testsprite test wait run_01hx3z9p8q4k2y7a --timeout 600 --output json
testsprite test wait run_aaaa run_bbbb run_cccc --timeout 900 --output json
testsprite test wait run_01hx3z9p8q4k2y7a --dry-run --output json
```

With several ids, a per-member poll error (e.g. one id not found) is recorded as `error:<CODE>` in that run's row and folded into exit 7, rather than aborting the whole batch. Polling is handled automatically — the CLI uses server-driven long-poll where supported and exponential backoff with jitter otherwise, honoring `Retry-After`.

#### `testsprite test artifact get <run-id>`

Download the failure bundle for a specific `runId`. Same on-disk layout as `test failure get`, but addressed by `runId` instead of `testId`, so an agent can fetch the bundle for the exact run it just triggered — never a newer failure on the same test. Default `<dir>` is `./.testsprite/runs/<run-id>/`. The CLI enforces `meta.runId === <run-id>` as an integrity check; a mismatch exits 5 rather than silently writing the wrong bundle.

```bash
testsprite test artifact get run_01hx3z9p8q4k2y7a --output json
testsprite test artifact get run_01hx3z9p8q4k2y7a --out ./.testsprite/runs/run_01hx3z9p8q4k2y7a
testsprite test artifact get run_01hx3z9p8q4k2y7a --failed-only
testsprite test artifact get run_01hx3z9p8q4k2y7a --dry-run --output json
```

Returns 404 (CLI exit 4) when the run passed (`details.reason: "no_failing_run"`), is still in flight (`run_not_ready`), was cancelled (`cancelled_no_artifacts`), or its test was deleted (`no_code`).

### Account & diagnostics

#### `testsprite usage` (alias: `testsprite credits`)

Account pre-flight before a large batch: resolves the active key to its identity (`userId`, `keyId`, `env`) and surfaces the credit balance / plan fields when the backend supplies them. Useful right before a `test run --all` fan-out.

```bash
testsprite usage --output json
testsprite credits
testsprite usage --dry-run --output json
```

#### `testsprite doctor`

One-shot environment diagnostic. Runs a fixed checklist — CLI version, Node.js runtime, active profile, API endpoint, credentials, live connectivity + key validity (`GET /me`), and whether the verify skill is installed in the current project — and prints an OK/WARN/FAIL report. Exits non-zero only when a check **fails** (warnings, e.g. skill not installed, don't fail the process), so it can gate a CI step or an agent preflight:

```bash
testsprite doctor
testsprite doctor --output json
testsprite doctor && testsprite test run test_xxxxxxxx --wait
```

Every check reuses the same helpers the real commands use, so the report reflects exactly what a subsequent command would resolve.

## Configuration

### Profiles & credentials

Credentials live at `~/.testsprite/credentials` (INI-style, mode `0600`) — one section per profile. **Profile resolution order** (highest first): `--profile` flag → `TESTSPRITE_PROFILE` env → `default`. Within a profile, the `TESTSPRITE_API_KEY` / `TESTSPRITE_API_URL` env vars override the file, so CI can run without ever touching `~/.testsprite/credentials`.

### Global flags

These apply to every command:

| Flag                          | Purpose                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `--profile <name>`            | Pick a named profile (default: `default`)                                                       |
| `--endpoint-url <url>`        | Override the API host                                                                           |
| `--output json\|text`         | JSON is the stable automation contract; text is human-friendly                                  |
| `--request-timeout <seconds>` | Per-request wall-clock timeout (default 120, range 1–600)                                       |
| `--verbose`                   | Human-readable HTTP retry / backoff / polling messages to stderr                                |
| `--debug`                     | Method / URL / request-id / latency / retry decisions to stderr (the API key is never included) |
| `--dry-run`                   | Run end-to-end with no network, credentials, or filesystem writes; emits canned data            |

### Environment variables

| Variable                                  | Purpose                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `TESTSPRITE_API_KEY`                      | API key — overrides the credentials file                                                 |
| `TESTSPRITE_API_URL`                      | API endpoint — overrides the credentials file                                            |
| `TESTSPRITE_PROFILE`                      | Active profile (below `--profile`, above `default`)                                      |
| `TESTSPRITE_REQUEST_TIMEOUT_MS`           | Per-request timeout in **milliseconds** (default `120000`, range `1000`–`600000`)        |
| `TESTSPRITE_NO_UPDATE_NOTIFIER`           | Any non-empty value disables the once-per-24h "new version available" notice             |
| `NO_COLOR`                                | Suppress ANSI escape sequences in ticker output ([no-color.org](https://no-color.org/))  |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | Standard proxy support — API traffic is routed through the configured proxy              |
| `TESTSPRITE_NO_SKILL_WARNING`             | Any non-empty value silences the "verify skill not installed" reminder (CI / manual use) |
| `TESTSPRITE_PORTAL_URL`                   | Override the Portal origin used for `dashboardUrl` links (non-prod environments)         |

### Update notice

Interactive runs print a one-line "new version available" notice on stderr when
a newer release exists. To learn this, the CLI contacts the public npm registry
(`registry.npmjs.org`) at most once per 24 hours; the request carries the
package name only — never your API key, project data, or command line. The
check is skipped in CI, when stderr is not a TTY, under `--output json` /
`--dry-run`, and entirely when `TESTSPRITE_NO_UPDATE_NOTIFIER` is set. Any
failure is silent: the notice can never break or delay a command. This is the
only outbound call the CLI makes besides your configured API endpoint.

### Scopes

API-key scopes gate the write and run surfaces:

| Scope            | Required by                                                          |
| ---------------- | -------------------------------------------------------------------- |
| `read:me`        | `auth status`, `usage`, `doctor` (connectivity check)                |
| `read:projects`  | `project list / get`                                                 |
| `read:tests`     | every `test *` read command                                          |
| `write:tests`    | `test create / create-batch / update / delete / code put / plan put` |
| `write:projects` | `project create / update / credential / auto-auth`                   |
| `run:tests`      | `test run / rerun / flaky / wait / artifact get`                     |

New API keys include the full scope set. If a command returns `AUTH_FORBIDDEN`, the missing scope is named in `details.requiredScope` — regenerate your key from the dashboard to pick up new scopes.

## Output & scripting

JSON is the stable, machine-readable contract; pipe it straight into `jq` or a coding agent:

```bash
# Grab the runId of a freshly triggered run
RUN_ID=$(testsprite test run test_xxxxxxxx --output json | jq -r '.runId')

# Wait on it and branch on the exit code
testsprite test wait "$RUN_ID" --timeout 600 --output json || echo "run did not pass"
```

## Exit codes

| Code                  | Meaning                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| `0`                   | Success                                                                     |
| `1`                   | Generic failure / non-passed run status                                     |
| `2`                   | Not yet implemented                                                         |
| `3`                   | Auth error                                                                  |
| `4`                   | Not found                                                                   |
| `5`                   | Validation error / payload too large                                        |
| `6`                   | Conflict / precondition failed                                              |
| `7`                   | Timeout / unsupported                                                       |
| `10`                  | Service unavailable                                                         |
| `11`                  | Rate limited (retriable)                                                    |
| `12`                  | Insufficient credits (non-retriable)                                        |
| `13`                  | Feature gated (paid plan required)                                          |
| `129` / `130` / `143` | Interrupted by a signal (SIGHUP / SIGINT / SIGTERM) — `128 + signal number` |

### Signals & pipes

On SIGINT (Ctrl-C), SIGTERM, or SIGHUP the CLI prints `Interrupted (<signal>). Any run already started keeps executing on the server; check it with 'testsprite test list' or 'testsprite test wait <run-id>'.` and exits `128 + signal`. **Ctrl-C does not cancel the server-side run** — execution (and any credit spend) continues; there is no cancel command today, so re-attach with `test wait <run-id>` instead of re-triggering. A closed stdout pipe (`EPIPE`, e.g. `testsprite test list | head`) exits `0` silently rather than crashing.

## Design principles

1. **Resource-oriented.** Verbs (`list`, `get`) operate on resources (`project`, `test`, `run`).
2. **Scriptable.** Every command supports `--output json` for machine-readable output.
3. **Stateless.** No local database; the TestSprite backend is the source of truth.
4. **Composable.** Output is pipe-friendly and pairs well with `jq`.
5. **Agent-safe.** Reads that span multiple entities share a `snapshotId` and refuse to stitch data from different runs or code versions.
