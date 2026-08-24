# `testsprite` CLI — Documentation

The full reference for the TestSprite CLI: install verification, manual setup, every command with examples, configuration, scripting, and exit codes.

> Looking for the quick tour? Start with the [README](./README.md).
> This reference will progressively move to [docs.testsprite.com](https://www.testsprite.com/docs); this file is the source of truth until then.

## Contents

- [Install & verify](#install--verify)
- [Manual setup](#manual-setup)
- [The complete agent loop](#the-complete-agent-loop)
- [Agent onboarding (`agent install`)](#agent-onboarding-agent-install)
- [Plan file format](#plan-file-format)
- [Command reference](#command-reference)
  - [Read commands](#read-commands)
  - [Write commands](#write-commands)
  - [Run commands](#run-commands)
  - [Test lists (`testlist`)](#test-lists-testlist)
  - [Schedules (`schedule`)](#schedules-schedule)
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

For an org-scoped API key, `auth status` additionally prints an `orgs:` line (every organization your account belongs to) and an `org binding:` line (the specific organization this key is bound to). Both are omitted for a personal key or an older backend that doesn't report them.

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

## Plan file format

A **plan file** is the JSON document `test create --plan-from <file>` ingests to author one **frontend** test (bulk-create takes the same shape, one spec per line/file — see [`test create-batch`](#testsprite-test-create-batch)). It holds exactly **ONE** test as a single JSON object — a top-level array is rejected (use `create-batch` for many).

```json
{
  "$schema": "https://raw.githubusercontent.com/TestSprite/testsprite-cli/v0.4.0/schemas/plan.schema.json",
  "projectId": "prj_abc123",
  "type": "frontend",
  "name": "Login rejects an empty password",
  "planSteps": [
    {
      "type": "action",
      "description": "Navigate to /login and submit the form with an empty password"
    },
    {
      "type": "assertion",
      "description": "Verify an inline error says the password is required"
    }
  ]
}
```

Get this exact skeleton without hand-copying it from this file: `testsprite test create --plan-template` (pure-local, prints to stdout — see [`test create`](#testsprite-test-create)). The same example is embedded in `test create --help`. **The `$schema` value above is pinned to the CLI version that generated this page (`v0.4.0`)** — `--plan-template`'s live output always pins to your actually-installed version instead, so on a later release the two will differ; run the command yourself rather than trusting this snippet's `$schema` value verbatim.

| Field         | Required | Type                                                            | Notes                                                                                                                                                                                                                            |
| ------------- | -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`   | yes      | string                                                          | Returned by `testsprite project list`. Non-empty, not whitespace-only.                                                                                                                                                           |
| `type`        | yes      | `"frontend"`                                                    | `--plan-from` only accepts `frontend` — a `backend`-typed plan is rejected pre-flight with a `nextAction` pointing at `test create --type backend --code-file <path>` (backend tests are authored from a code file, not a plan). |
| `name`        | yes      | string                                                          | An assertable behavior statement (subject + verb + outcome), not a noun fragment.                                                                                                                                                |
| `description` | no       | string                                                          | One-sentence elaboration of `name` — the condition plus the expected outcome.                                                                                                                                                    |
| `priority`    | no       | `"p0"` \| `"p1"` \| `"p2"` \| `"p3"`                            | p0 = must-pass, p1 = important paths, p2 = edge cases, p3 = cosmetic.                                                                                                                                                            |
| `viewport`   | no       | string                                                          | Browser viewport for the frontend runner, in `<width>x<height>` form (e.g. `"390x844"` for a mobile device). Forwarded to the backend so the browser-use runner can size the viewport before executing plan steps. Absent means the runner's desktop default.                                        |
| `planSteps`   | yes      | `Array<{ type: "action" \| "assertion", description: string }>` | **1–200 steps**, describing user intent in plain language, not selectors.                                                                                                                                                        |

**Size cap:** the whole file must be **≤ 256 KB** (`test create-batch` caps the aggregate batch at 5 MB / 50 specs). Both caps are enforced client-side before any network call.

**`{{...}}`-style placeholders are NOT substituted.** The CLI does no variable substitution — a step like `"description": "log in as {{LOGIN_USER}}"` is structurally valid (it validates and creates fine) but the browser agent types the literal braces into the field. `test create --plan-from` prints a non-fatal `[advisory]` when it detects one; store login credentials on the project instead: `testsprite project update <project-id> --username <user> --password <pw>`, or Portal → Project Settings.

**`$schema` for live editor validation:** the optional `"$schema"` key above (an ordinary extra property — the CLI does not restrict a plan file to a fixed property set, so a non-string value there is exactly as valid as a string one) points VS Code's JSON language service — and by extension Copilot's inline completions — at [`schemas/plan.schema.json`](./schemas/plan.schema.json), shipped in both this repo and the npm package. Point it at a local copy instead (`node_modules/@testsprite/testsprite-cli/schemas/plan.schema.json`) if you'd rather not depend on the network URL resolving in your editor. This value is **version-pinned** (`v<CLI version>`, not `main`) — a plan authored against one CLI version keeps resolving the SAME schema later, even after `main` gains new required fields.

**Machine-readable ground truth**, for tooling that wants to fetch the contract instead of parsing this page: [`schemas/plan.schema.json`](./schemas/plan.schema.json) — this schema is the ground truth for the `--plan-from` **command** end-to-end (e.g. it restricts `type` to `"frontend"` only, matching what actually succeeds, not `assertPlanShape`'s looser raw structural check in isolation); if the schema and the validator ever disagree, the validator's real acceptance behavior is authoritative and the schema is out of date. The schema file's own internal `$id` intentionally stays pinned to the canonical `main` URL — `$id` is the schema's IDENTITY (what it calls itself for cross-referencing), not a fetch instruction, so it does not need version-pinning the way the `$schema` fetch hint above does.

**Multiple tests?** Draft a `plans.jsonl` (one plan object per line) or a directory of `*.json` plan files, then `test create-batch --plans <file.jsonl>` / `--plan-from-dir <dir>`. Max 50 specs / 5 MB per batch.

**Zero-cost iteration loop:** `test create --plan-from <file> --dry-run` runs the exact same local validation as a real create — no network call, no auth, no credits spent — so an agent (or you) can iterate on a plan file until it validates before ever hitting the API. `test lint` runs the same validators across a whole batch, collecting every problem instead of stopping at the first.

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

For an org-scoped API key, the text table gains an `ORG` column (project owning organization) whenever at least one row carries org attribution; a personal key or a page with no org data keeps the legacy column set unchanged. `--output json` always includes `orgId`/`orgName` when the backend supplies them.

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

Get a single test by id. Test ids look like `test_xxxxxxxx` and come from `test list`. Backend tests echo their dependency declarations — `produces` / `consumes` / `category` — when present.

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

Get the latest result for a test — status, started / finished timestamps, video and failure-analysis URLs, summary counts (`passed / failed / skipped`), and correlation fields (`snapshotId`, `runId`, `codeVersion`). With `--include-analysis`, the response also carries an inline `analysis` block (root-cause hypothesis, recommended fix target, failure kind). Backend tests additionally surface the run's captured stdout (`apiOutput`) and Python traceback (`trace`): full content under `--output json` (and in `result.json` / `failure.json` inside failure bundles); text mode prints a bounded 20-line tail of each with a byte count.

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

Require the `write:tests` scope (project commands require `write:projects`), except `test scaffold`, `test lint`, and `test create --plan-template`, which are pure-local authoring helpers — no network, no credentials, no scope.

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

Create a new test. Backend tests use `--code-file` (agents supply backend code directly); frontend tests use either `--code-file` or `--plan-from` (see [Plan file format](#plan-file-format)). With `--run --wait`, the CLI chains create → trigger → poll in a single invocation. Backend tests can declare wave-ordering dependencies at create time — `--produces <var>` / `--needs <var>` (repeatable) and `--category <setup|main|teardown>` — and amend them later via `test update`.

`--plan-template` prints the canonical minimal plan-file skeleton to stdout and exits — pure-local, no network/credentials, ignores every other flag. The exact same example is embedded in `test create --help`.

```bash
# Backend test from a code file
testsprite test create --project proj_xxxxxxxx --type backend --name "Login API" \
  --code-file ./login.py

# Frontend test from an agent-supplied plan-steps document; trigger + wait inline
testsprite test create --plan-from ./checkout.plan.json --type frontend \
  --run --wait --timeout 600 --output json

# Print the plan-file skeleton, edit it, then create from it
testsprite test create --plan-template > plan.json

# Dry-run prints the canned wire envelope
testsprite test create --plan-from ./checkout.plan.json --dry-run --output json
```

#### `testsprite test create-batch`

Bulk-create frontend tests from a JSONL plan-steps file (or a directory of plan files with `--plan-from-dir`). Optional `--run --max-concurrency <N>` fans out triggers. Without `--wait`, each run is dispatched (`status: "queued"`) and the command exits 0 when every trigger is accepted — mirroring single `test run` without `--wait`; a trigger error still exits non-zero. With `--wait`, it polls every run to terminal and exits non-zero if any run does not pass.

```bash
testsprite test create-batch --plans ./plans.jsonl --run --max-concurrency 4 --output json
testsprite test create-batch --plan-from-dir ./plans/ --dry-run --output json
```

#### `testsprite test update <test-id>`

Update test metadata (name, description, priority) — and, for **backend tests**, the dependency declarations: `--produces <var>` / `--needs <var>` (repeatable) and `--category <setup|main|teardown>`. Updated declarations are echoed back by `test get`.

```bash
testsprite test update test_xxxxxxxx --name "Renamed test" --description "Updated"
testsprite test update test_be_xxxx --produces session_token --category setup
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

**V3-migrated accounts:** the backend returns `UNSUPPORTED` (exit 7, with an actionable `nextAction`) for this endpoint on accounts that have been migrated to V3 — plan-steps replacement isn't wired up for the V3 test-case schema yet. This is a clean, expected denial (not a bug); there is currently no CLI-side workaround.

#### `testsprite project create` / `project update`

Manage projects from the CLI. Both pre-flight `--url` against local addresses for fast feedback. Projects have **no description field** — `--description` is rejected client-side with a validation error (descriptions live on tests: `test create --description`). `project update` accepts `--name`, `--url`, `--username`, `--password`, `--password-file`, and `--instruction`.

```bash
testsprite project create --type frontend --name "Checkout" --url https://staging.example.com
testsprite project update proj_xxxxxxxx --name "Checkout v2"
```

#### `testsprite project delete <project-id>`

Permanently delete a project and **everything under it** — its frontend/backend sub-projects, all their tests, and backend fixtures (mirrors the Portal's cascade delete). There is **no restore window**. `--confirm` is required (the CLI never prompts); absent it, the CLI exits 5 with a local validation error. `--dry-run` previews the response shape without a network call. Exit codes: 0 success, 3 auth, 4 not found (or already deleted), 5 validation.

```bash
testsprite project delete proj_xxxxxxxx --confirm
testsprite project delete proj_xxxxxxxx --dry-run --output json
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

# GitHub-native CI output: ::error:: annotations + job-summary table + machine summary
testsprite test run test_xxxxxxxx --wait --summary-file ./summary.json --output json
```

Batch `--report` flags apply only to `test run --all --wait` (and batch `test rerun --wait`). `--report junit --report-file <path>` writes a JUnit XML sidecar after polling completes (atomic write); `--output json` is unchanged. Optional `--report-suite-name <name>` overrides the default `testsprite:<projectId>` suite name.

**GitHub-native CI output** (contributed in [#264](https://github.com/TestSprite/testsprite-cli/pull/264)): when `GITHUB_ACTIONS=true`, any `test run --wait` (single test or `--all`), any batch `test rerun --wait`, and `testlist run --wait` additionally emit one `::error::` workflow-command line per non-passed run (annotating the PR checks tab) and append a Markdown results table to the job summary (`$GITHUB_STEP_SUMMARY`). Pass `--gh-output` to force the annotations outside Actions (previewable locally), and `--summary-file <path>` to also write the reduced machine summary JSON (`{total, passed, failed, timedOut, runs[]}`). Everything is written even when the command exits non-zero — including a batch where nothing dispatched at all (every test already in flight → exit 6, or every test rate-deferred → exit 7), which still surfaces its verdict in CI rather than failing silently. Every write is best-effort — a failed write never changes the exit code. Tests that never dispatched (rate-deferred, conflicted, not found) appear as non-passed rows, so a partial batch cannot read as all-passed. Annotation and table content is escaped, so run-error text cannot inject workflow commands or break the table.

`--target-url` must be a publicly reachable URL — the CLI pre-flights it against local addresses (`localhost`, `127.x`, `::1`, `0.0.0.0`, `169.254.x`, RFC1918) and the backend resolves it via DNS. For testing against localhost, use the [TestSprite MCP plugin](https://www.testsprite.com/docs), which handles the local tunnel.

**Reachability preflight (refuse before charge).** Beyond the literal local-address check, the CLI now probes the target **before dispatching** (and before anything is billed): a DNS resolve plus a lightweight HTTP request. A confirmed-dead target — DNS `NXDOMAIN`, connection refused, or a `502`/`503`/`504` gateway error (the signature of a tunnel that has gone away) — is refused with a validation error (exit 5) instead of dispatching a run that can only fail against a URL nobody is serving. A resolved address that lands in private/loopback/link-local space is always refused (the hostname passed the literal check but actually points somewhere unreachable from the runner). Ambiguous signals — a timeout, a TLS error, an odd status — only produce a stderr warning and never block; behind a configured HTTP(S) proxy, a local DNS failure is also downgraded to a warning, since resolution really happens at the proxy. `--skip-preflight` (on `test run`, `test create`, and `test create-batch`) opts out entirely — no extra network calls. Note: for a backend test the probe is a heuristic (the test's own base URL is baked into its code) — reach for `--skip-preflight` if a refusal surprises you there.

The `[advisory]` about `--target-url` on V3-routed accounts is now **response-driven**: the CLI reads the run's actual trigger response rather than guessing from account flags, so it fires only when the override genuinely did not take effect (newer backends apply `--target-url` to fresh frontend runs on V3; older ones ignore it and the advisory says so). The CLI auto-mints an idempotency key (printed to stderr under `--output json`, `--verbose`, or `--debug`); pass `--idempotency-key <uuid>` to control it explicitly.

**`--wait` exit-code precedence (shared across `test run --all`, batch `test rerun`, and `testlist run`).** When a fan-out poll ends with a mix of outcomes, the process exit code is resolved through one shared precedence table — batch-wide non-retriable first: auth (3) and client-too-old (14), then per-run non-retriable (12 insufficient credits, 13 feature-gated), then per-run errors (4/5/6), then transient (11 rate-limited, 10 unavailable), then timeout (7), then the generic failure (1). A per-member poll error now surfaces its real code instead of folding into 7/1. Batch conflicts are **reason-aware**: a `run_in_flight` conflict with a known `runId` is auto-resumed under `--wait` (the CLI polls the in-flight run to its verdict instead of exiting 6), and other causes — a view-only mirror project, an un-runnable/local environment, an unknown id, a dispatch error — are named individually rather than reported as a blanket "already in flight". Rate-deferred tests are retried on a time budget: retries continue until `--timeout` minus a reserved final poll window (60 s, or a third of the timeout for short timeouts), rather than a fixed attempt count.

#### `testsprite test rerun [test-id...]`

Re-execute one or more tests as a **replay** — distinct from `test run`, which triggers a fresh agent run that may regenerate code. A frontend rerun replays the saved script (verbatim unless AI heal-on-drift engages — see `--auto-heal`); a backend rerun re-runs the named test together with its producer/teardown dependency closure. A rerun is billed the same as a fresh run — 0.5 credits per FE rerun, 0.2 credits per BE rerun (legacy V2 accounts: FE rerun remains free). Without `--wait`, prints the queued run(s) and exits 0; with `--wait`, polls to terminal with the same exit-code matrix as `test run --wait`.

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
- `--auto-heal` / `--no-auto-heal` — frontend AI heal-on-drift, **on by default** for FE reruns; opt out with `--no-auto-heal`. The rerun itself is billed at 0.5 credits regardless of whether heal engages; a heal engage costs a small amount of credit on top of that (legacy V2 accounts: a verbatim-replay pass is free, and only a heal engage costs credit). Ignored for backend tests. On V3-routed accounts the `--no-auto-heal` opt-out is still rolling out and may not yet be honored server-side.
- `--skip-dependencies` — backend only: rerun just the named test without expanding the producer/teardown closure.
- `--max-concurrency <n>` — with `--wait`, cap on in-flight polls during a batch rerun.
- `--idempotency-key <key>` — auto-minted when omitted (the minted key is printed to stderr under `--output json`, `--verbose`, or `--debug`).
- `--report junit --report-file <path>` — with batch `--wait`, write a JUnit XML sidecar after polling (atomic write). Optional `--report-suite-name <name>` overrides the default `testsprite:<projectId>` suite name. Requires `--wait`; not available on single-test reruns.
- `--gh-output` / `--summary-file <path>` — with batch `--wait`: GitHub-native CI output, same behavior as on `test run` (see above) — `::error::` annotations per non-passed run, a job-summary table under GitHub Actions, and the reduced machine summary JSON. Not available on single-test reruns.

A batch rerun returns `accepted[]` (one `runId` per dispatched test) plus `deferred[]` for any test shed by the per-key run-rate limit; under `--wait`, a non-empty `deferred[]` exits 7 with a `nextAction` you can retry with a fresh idempotency key.

#### `testsprite test flaky <test-id>`

Detect a **flaky** test by replaying it several times and reporting how often it passes. Each attempt is a rerun with auto-heal **off** (a strict verbatim replay), so healed drift can't disguise a nondeterministic pass/fail — this measures the replay stability of the saved script against the configured URL. Each replay is billed as a rerun, same as a fresh run: 0.5 credits for a frontend replay, 0.2 credits for a backend replay (legacy V2 accounts: FE rerun remains free) — so `--runs N` costs roughly N×0.5 credits for a frontend test. A one-line stderr advisory is printed before a backend replay.

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

A `RATE_LIMITED` (429) poll is the one per-member error that is retried before it becomes an outcome: each member re-polls up to 3 times, sleeping the server's `Retry-After`. Each backoff is clamped to the shared `--timeout` deadline, and a backoff interrupted by Ctrl-C detaches normally; if the deadline is reached during one, that member reports a **timeout** (exit 7), not a rate limit.

If the throttle outlasts the retry budget **and** nothing else went wrong — no timeouts, no failed runs, no other error codes, and no repeated run id in the argument list — the exit code is **11** (rate limited) rather than 7, because the correct next action is to back off before re-attaching, not to retry immediately. Any timeout or non-passed run in the same invocation keeps the usual 7 / 1.

One caveat this does not fix: the HTTP layer's own 429 retries (up to 3, honoring `Retry-After`) are bounded by their own budget, not by `--timeout`, so a sustained throttle can still overshoot the deadline by roughly one retry chain before the command gives up. That is pre-existing behavior on every polling command, not something this retry loop introduced — the outer loop re-checks the deadline before each of its own attempts.

#### `testsprite test cancel <run-id...>`

Cancel one or more in-flight runs — the counterpart to Ctrl-C, which only **detaches** (the server-side run keeps executing and billing). Cancelling is idempotent: an already-cancelled run reports `alreadyCancelled` as an advisory, not an error; a run that already reached a terminal verdict is a conflict — the verdict is never overwritten, and no credits are refunded. With one id, prints the run card; with several, prints a `{ cancelled, alreadyCancelled, conflicts, notFound }` summary. Exit codes: any unknown id → 4; else any conflict → 6; else 0.

```bash
testsprite test cancel run_01hx3z9p8q4k2y7a
testsprite test cancel run_aaaa run_bbbb --output json
testsprite test cancel run_01hx3z9p8q4k2y7a --dry-run --output json
```

#### `testsprite test artifact get <run-id>`

Download the failure bundle for a specific `runId`. Same on-disk layout as `test failure get`, but addressed by `runId` instead of `testId`, so an agent can fetch the bundle for the exact run it just triggered — never a newer failure on the same test. Default `<dir>` is `./.testsprite/runs/<run-id>/`. The CLI enforces `meta.runId === <run-id>` as an integrity check; a mismatch exits 5 rather than silently writing the wrong bundle.

```bash
testsprite test artifact get run_01hx3z9p8q4k2y7a --output json
testsprite test artifact get run_01hx3z9p8q4k2y7a --out ./.testsprite/runs/run_01hx3z9p8q4k2y7a
testsprite test artifact get run_01hx3z9p8q4k2y7a --failed-only
testsprite test artifact get run_01hx3z9p8q4k2y7a --dry-run --output json
```

Returns 404 (CLI exit 4) when the run passed (`details.reason: "no_failing_run"`), is still in flight (`run_not_ready`), was cancelled (`cancelled_no_artifacts`), or its test was deleted (`no_code`).

### Test lists (`testlist`)

A **test list** is a saved, named collection of tests — the CLI surface for the portal's `Tools → Test Lists`. A list can span multiple projects, and each project in it can be pinned to a specific environment (`--project-env <projectId>:<envName>`) so `testlist run` executes every case against the environment the list configured. **Test lists are V3-only**: a non-V3 account gets `UNSUPPORTED` (exit 7). `testId` on the wire is the logical test id (the same id `test list` / `test get` return); no translation is needed.

```bash
# Read
testsprite testlist list                                  # all lists visible to the key
testsprite testlist list --output text                    # aligned table (ID / NAME / CASES / LAST_EXEC / UPDATED)
testsprite testlist get <list-id>                         # the list with its cases + pass/fail stats

# Write (each mutation takes an auto-minted Idempotency-Key; pass --idempotency-key to control it)
testsprite testlist create --name "Checkout smoke" \
  --project-env proj_aaaa:staging --project-env proj_bbbb:prod
testsprite testlist update <list-id> --name "Renamed"     # rename
testsprite testlist update <list-id> --project-env proj_aaaa:prod   # replace the env mapping
testsprite testlist update <list-id> --clear-project-env  # remove all env mappings (distinct from omitting the flag)
testsprite testlist add <list-id> <test-id...>            # add tests
testsprite testlist remove <list-id> <test-id...>         # remove tests
testsprite testlist delete <list-id> --confirm            # destructive — requires --confirm

# Run — dispatch the list's cases and return pollable run ids
testsprite testlist run <list-id>                         # fire-and-return; prints accepted runIds, exit 0
testsprite testlist run <list-id> --case <test-id> --case <test-id>   # run only a subset
testsprite testlist run <list-id> --wait --timeout 600 --output json  # poll every run to a verdict
testsprite testlist run <list-id> --wait --report junit --report-file ./results.xml
```

**`testlist run`** dispatches each case through its project's configured environment and returns a pollable `runId` per case (the same id `test wait` / `runs` accept). Without `--wait` it exits 0 once every case is accepted (a fire-and-return, like `test run` without `--wait`). With `--wait` it polls every run to terminal and the exit code reflects the batch: **0** all passed, **1** any failed, **4** a partial `--case` miss — some requested ids are not members of the list (checked after the poll, so a genuine failure or timeout on the matched subset is reported first; the missed ids are warned to stderr at dispatch and carried on `notFound` in the JSON), **6** nothing new was dispatched because every targeted case conflicted — causes are named individually (already in flight, view-only mirror project, un-runnable environment, unknown id, dispatch error), and this exits 6 on the non-`--wait` path too, **7** any run timed out (against `--timeout`, default 600 s) or was rate-deferred (also on the non-`--wait` path — a partial dispatch never passes CI silently). A per-member poll error surfaces its real exit code through the shared `--wait` precedence table (see `test run`). `--case <test-id>` (repeatable) runs a subset; an empty match (no accepted, no conflicts) returns a `reason` and exits 0. `--report junit --report-file <path>` writes a JUnit sidecar after polling (suite name defaults to `testsprite:testlist:<listId>`; override with `--report-suite-name`; unlike `test run --all` / `test rerun` reports, `<testcase>` rows currently carry the test id as the name and no duration). Under `GITHUB_ACTIONS=true` (or `--gh-output` to force it locally) a `--wait` run also emits `::error::` annotations + a job-summary table, and `--summary-file <path>` writes the reduced machine summary JSON (`{total, passed, failed, timedOut, runs[]}`); both require `--wait`, and non-dispatched members (conflicted, not-found) fold into the summary as non-passed rows so a partial run cannot read as all-passed.

Every mutation (`create`/`update`/`delete`/`add`/`remove`) is refused with a billing-hold envelope on a **paused** team workspace (matching the portal's read-only wall); `delete` also removes the list's schedules and their triggers, so it requires `--confirm`. All commands accept the global `--output json|text` and `--dry-run` (offline shape-accurate sample).

### Schedules (`schedule`)

A **schedule** runs a project or a test list on a cron, unattended — the CLI surface for the portal's Monitoring view. Every firing is a full test run, billed like any other, so the CLI states how often a cron works out to **before** it sends the request. Schedules are **entitlement-gated**: a plan that does not include them gets `FEATURE_GATED` (exit 13), and an account or backend that does not serve schedules at all gets `UNSUPPORTED` (exit 7).

```bash
# Read
testsprite schedule list                       # table: ID / NAME / STATUS / TARGET / CRON / TZ / LAST RUN
testsprite schedule list --columns id,name,cron --no-header   # pick + reorder columns for scripts
testsprite schedule get <schedule-id>          # one schedule, one field per line
testsprite schedule run list <schedule-id>     # past runs: RUN ID / STATUS / TOTAL / PASS / FAIL / BLOCK / STARTED

# Create (each mutation sends an auto-minted Idempotency-Key; pass --idempotency-key to control it)
testsprite schedule create --name "Nightly checkout" \
  --target-type testList --target-id tl_aaaa \
  --cron "0 3 * * *" --timezone America/New_York \
  --send-to oncall@example.com,qa@example.com

# Update, pause, resume
testsprite schedule update <schedule-id> --name "Renamed"
testsprite schedule update <schedule-id> --cron "0 6 * * 1"   # re-states the new frequency first
testsprite schedule update <schedule-id> --pause              # stop it firing, keep the schedule
testsprite schedule update <schedule-id> --resume

# Delete — removes the schedule AND its run history, and stops future triggers
testsprite schedule delete <schedule-id> --confirm
```

**Target.** `--target-type project` runs the project's **entire live suite** on every tick — there is no way to schedule a subset of a project's tests, so use a test list for that. `--target-type testList` runs the list's cases, each through its project's configured environment (see [Test lists](#test-lists-testlist)). `--target-id` is the matching project id or test-list id, and a target that does not resolve is a `404` (exit 4). Deleting a test list also deletes its schedules.

**What a project tick dispatches.** The project's own type decides how its cases run: a **frontend** project's cases go through a shared rolling pool, so a nightly cannot open the whole suite's browser sessions against your site at once — the same cap a portal-triggered run gets; a **backend** project's cases are dispatched together as one fan-out — a scheduled tick does not currently order them producers-before-consumers the way `test run --all` does. Integration cases are not dispatched as targets: a full run re-assembles them from the units they compose once those have run, which is also why the per-run cost counts only the non-integration cases.

**Cron.** `--cron` is a standard 5-field expression — `minute hour day-of-month month day-of-week` — where day-of-week is `0-7`, with both `0` and `7` meaning Sunday. Constrain day-of-month **or** day-of-week, not both. `--timezone` takes an IANA zone and defaults to `UTC`. `--start` (default: a few minutes from now) and `--end` (default: open-ended) take ISO 8601 instants.

**The frequency is stated before the request, the cost as soon as the server prices it.** `create` — and `update --cron`, since retiming an existing schedule is the same order-of-magnitude mistake as creating one badly — print the frequency to stderr before sending, so a `*/5` typo is visible before it bills. The cost line follows the response, because the price comes from the API — except under `--dry-run`, which prints both offline against a canned figure:

```console
$ testsprite schedule create --name Nightly --target-type project --target-id proj_aaaa \
    --cron "0 3 * * *" --dry-run
This schedule will run ~30 time(s)/month (daily at 03:00). Each run is a full test run. Check your balance with `testsprite usage`.
[dry-run] sample response — not from the server
Estimated cost: ~5 credits/run, ~152 credits/month, based on the target's current case count.
id: sch_dryrun_2026
```

Both lines also appear under `--dry-run`, so that is reproducible offline with no key exactly as shown — the id and the per-run figure are the canned dry-run sample; a real create prices the run from the API. Compare a mistyped `--cron "* * * * *"`, which reads `~43800 time(s)/month` and `~219000 credits/month` before anything is created.

Outside `--dry-run` the cost line appears only when the API priced the run — no rate is invented locally. The per-run figure keeps up to two decimals, trailing zeros trimmed (rounding it to whole credits would stop the monthly total beside it from multiplying out); the monthly total is that price times the cron's frequency, rounded to whole credits, and is omitted for an expression the CLI cannot read. A cron it cannot read still gets the frequency advisory, naming the expression in place of a frequency.

**Status: `ENABLED` / `PAUSED` / `AUTO_PAUSED`.** `PAUSED` is what `update --pause` produces. `AUTO_PAUSED` means the platform disabled the schedule itself after repeated failures — currently 10 consecutive finished runs in which no test passed — reported as its own status precisely so it is not read as someone having paused it, and `schedule get` adds an `autoPaused:` timestamp line. `update --resume` re-enables either, and clears that failure streak.

**A tick with nothing to run reads as `failed` with a total of `0`.** Three things end a tick without dispatching anything: the target was deleted, it holds no live cases, or the previous tick is still running because the interval is shorter than a run takes. Each is recorded as a finished run — the history stays honest about the tick having happened — and `schedule run list` reports it as `failed` with `TOTAL 0`, deliberately: calling "nothing ran" a pass is the one answer that would let a dead schedule look healthy. So a `failed` row with `TOTAL 0` means nothing ran, not that tests failed. A tick skipped because the balance ran out records no row at all and resumes on its own once the balance recovers.

**`update` sends only the flags you passed.** With no field, no `--pause` and no `--resume` it exits 5 (`nothing to update`) rather than issuing an empty request; `--pause` together with `--resume` is refused (exit 5) rather than silently resolved to one of them. `--send-to` replaces the recipient list rather than adding to it.

**`delete` requires `--confirm`** (exit 5 without it), matching every other destructive verb: it removes the schedule and its run history and stops it firing, with no restore window — recreating it starts a fresh schedule. `--dry-run` works without `--confirm`.

**Idempotency.** `create`, `update`, and `delete` each send an auto-minted `Idempotency-Key`, so a retried command cannot double-apply; `--idempotency-key <key>` sets it yourself (reuse the same key to retry safely). An auto-minted key is echoed to stderr under `--output json`, `--verbose`, or `--debug`.

**Neither list is paginated.** `schedule list` and `schedule run list` return the full set — there is no cursor flag. Both take `--columns <keys>` and `--no-header` for scripting, and every subcommand accepts the global `--output json|text` and `--dry-run`.

Exit codes on top of the [shared set](#exit-codes): **7** schedules are not available on this account, **13** not available on your plan (`create` also uses 13 when the plan limit is reached), **4** schedule — or, for `create`, the target — not found, **6** idempotency conflict. Every subcommand's `--help` embeds its own list.

### Account & diagnostics

#### `testsprite usage` (alias: `testsprite credits`)

Account pre-flight before a large batch: resolves the active key to its identity (`userId`, `keyId`, `env`) and surfaces the credit balance / plan fields when the backend supplies them. Useful right before a `test run --all` fan-out. For an org-scoped key, also prints the `orgs:` / `org binding:` lines described under [Authenticate](#1-authenticate).

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

Every check reuses the same helpers the real commands use, so the report reflects exactly what a subsequent command would resolve. For an org-scoped key, the report also lists `Organizations` (account-wide membership list) and `Org binding` (this key's bound organization) checks.

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

| Variable                                   | Purpose                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `TESTSPRITE_API_KEY`                       | API key - overrides the credentials file                                                         |
| `TESTSPRITE_API_URL`                       | API endpoint - overrides the credentials file                                                    |
| `TESTSPRITE_PROFILE`                       | Active profile (below `--profile`, above `default`)                                              |
| `TESTSPRITE_PROJECT_ID`                    | Default project for `test list`, `test create`, and `test run --all` when `--project` is omitted |
| `TESTSPRITE_REQUEST_TIMEOUT_MS`            | Per-request timeout in **milliseconds** (default `120000`, range `1000`-`600000`)                |
| `TESTSPRITE_NO_UPDATE_NOTIFIER`            | Any non-empty value disables the once-per-24h "new version available" notice                     |
| `NO_COLOR`                                 | Suppress ANSI escape sequences in ticker output ([no-color.org](https://no-color.org/))          |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`  | Standard proxy support - API traffic is routed through the configured proxy                      |
| `TESTSPRITE_NO_SKILL_WARNING`              | Any non-empty value silences the "verify skill not installed" reminder (CI / manual use)         |
| `TESTSPRITE_NO_TELEMETRY` / `DO_NOT_TRACK` | Any truthy value (not `0`/`false`/empty) disables usage telemetry (see Telemetry below)          |
| `TESTSPRITE_PORTAL_URL`                    | Override the Portal origin used for `dashboardUrl` links (non-prod environments)                 |

### Telemetry

Authenticated runs send one best-effort "command outcome" event per invocation
to TestSprite (`POST /api/cli/v1/telemetry`) so we can measure which commands
run and diagnose failures. Each event carries only: the command name (e.g.
`test run`), the outcome (`success`/`error`/`abort`), the exit code, a machine
error **code** (e.g. `VALIDATION_ERROR`), the duration, and context (CLI
version, OS, Node version, output mode, CI-vs-interactive).

It **never** sends: your API key, target URLs, flag or argument values, or error
**messages**. The event is a fixed allowlist, bounded to ~1s, and fully
best-effort — it never delays beyond that, never changes a command's behavior or
exit code, and is skipped entirely when no API key is configured or under
`--dry-run`.

Opt out with `TESTSPRITE_NO_TELEMETRY=1` or the cross-tool
`DO_NOT_TRACK=1` (any truthy value; `0`/`false`/empty do not opt out).

### Update notice

Interactive runs print a one-line "new version available" notice on stderr when
a newer release exists. To learn this, the CLI contacts the public npm registry
(`registry.npmjs.org`) at most once per 24 hours; the request carries the
package name only - never your API key, project data, or command line. The
check is skipped in CI, when stderr is not a TTY, under `--output json` /
`--dry-run`, and entirely when `TESTSPRITE_NO_UPDATE_NOTIFIER` is set. Any
failure is silent: the notice can never break or delay a command. This is the
only outbound call the CLI makes besides your configured API endpoint.

Separately, the backend advertises its **minimum supported CLI version** on
every `/api/cli/v1` response. When the running CLI is below that floor, a
one-line upgrade advisory is printed to stderr (same opt-outs as the update
notice; it never changes the exit status). A backend may also reject a
too-old client outright with HTTP 426 - surfaced as `CLIENT_TOO_OLD`,
exit `14`, non-retriable, with upgrade guidance.

### Scopes

API-key scopes gate the write and run surfaces:

| Scope            | Required by                                                          |
| ---------------- | -------------------------------------------------------------------- |
| `read:me`        | `auth status`, `usage`, `doctor` (connectivity check)                |
| `read:projects`  | `project list / get`                                                 |
| `read:tests`     | every `test *` read command                                          |
| `write:tests`    | `test create / create-batch / update / delete / code put / plan put` |
| `write:projects` | `project create / update / delete / credential / auto-auth`          |
| `run:tests`      | `test run / rerun / flaky / wait / cancel / artifact get`            |

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

| Code                  | Meaning                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `0`                   | Success                                                                                           |
| `1`                   | Generic failure / non-passed run status                                                           |
| `2`                   | Not yet implemented                                                                               |
| `3`                   | Auth error                                                                                        |
| `4`                   | Not found                                                                                         |
| `5`                   | Validation error / payload too large                                                              |
| `6`                   | Conflict / precondition failed / ambiguous org (see below)                                        |
| `7`                   | Timeout / unsupported                                                                             |
| `10`                  | Service unavailable                                                                               |
| `11`                  | Rate limited (retriable)                                                                          |
| `12`                  | Insufficient credits (non-retriable)                                                              |
| `13`                  | Feature gated (paid plan required)                                                                |
| `14`                  | Client too old — the backend requires a newer CLI (HTTP 426 `CLIENT_TOO_OLD`); upgrade to proceed |
| `129` / `130` / `143` | Interrupted by a signal (SIGHUP / SIGINT / SIGTERM) — `128 + signal number`                       |

### Ambiguous org id (exit 6)

For a membership-scoped API key, a testId can — pathologically — resolve to
projects in more than one of your organizations. The CLI prints one
`candidate: project <id> (org <id>)` line per colliding project plus a hint
to re-run with `--project <id>`, and exits `6` (same family as a generic
conflict; retrying does not resolve it). `--output json` carries the same
information in `error.details.candidates`.

### Signals & pipes

During any `--wait`, SIGINT (Ctrl-C), SIGTERM, or SIGHUP triggers a **graceful detach**: the in-flight request aborts immediately, stdout gets the same partial `{ runId, status: "running" }` envelope as the request-timeout path (under `--output json`, stderr carries an `INTERRUPTED` envelope naming the signal), and stderr states the truth — the server-side run keeps executing, and any credit spend continues — with a re-attach hint (`test wait <run-id>`) and a `test cancel <run-id>` pointer. The exit code is `128 + signal` (130 / 143 / 129). A second signal forces an immediate hard exit. Outside a `--wait` (prompts, one-shot commands), signals keep the pre-existing immediate-exit behavior. **Ctrl-C never cancels the server-side run** — `test cancel <run-id...>` is the explicit stop. A closed stdout pipe (`EPIPE`, e.g. `testsprite test list | head`) exits `0` silently rather than crashing.

## Design principles

1. **Resource-oriented.** Verbs (`list`, `get`) operate on resources (`project`, `test`, `run`).
2. **Scriptable.** Every command supports `--output json` for machine-readable output.
3. **Stateless.** No local database; the TestSprite backend is the source of truth.
4. **Composable.** Output is pipe-friendly and pairs well with `jq`.
5. **Agent-safe.** Reads that span multiple entities share a `snapshotId` and refuse to stitch data from different runs or code versions.
