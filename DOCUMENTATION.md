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
  - [Generate commands](#generate-commands)
  - [Run commands](#run-commands)
  - [Local frontend testing and tunnels](#local-frontend-testing-and-tunnels)
  - [Test lists (`testlist`)](#test-lists-testlist)
  - [Schedules (`schedule`)](#schedules-schedule)
  - [CI integration (`ci init`)](#ci-integration-ci-init)
  - [Account & diagnostics](#account--diagnostics)
- [Configuration](#configuration)
- [Output & scripting](#output--scripting)
- [Continuous integration](#continuous-integration)
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

`--dry-run` is a global flag that emits a canned sample matching the API contract without writes or charges. Credentialless previews and explicit targets remain offline. With configured credentials, `test run` may make bounded read-only metadata requests to show an automatic tunnel decision; it never mints a tunnel or dispatches runs. It's the right way to confirm an install or learn the surface before configuring auth — the response _shapes_ match the wire contract, but the data is fake.

## Manual setup

The recommended path is `testsprite setup` (see the [README quickstart](./README.md#quickstart)). If you prefer to configure each step separately:

### 1. Authenticate

The CLI uses API keys. Create one from your [TestSprite dashboard](https://www.testsprite.com/dashboard/settings/apikey), then configure it:

```bash
# Interactive — prompts for your API key (input is masked); endpoint defaults to prod
testsprite setup --no-agent

# Non-interactive — reads TESTSPRITE_API_KEY from the environment (CI / scripts)
TESTSPRITE_API_KEY=sk-... testsprite setup --from-env --no-agent

# Verify
testsprite auth status
```

Credentials are normally stored at `~/.testsprite/credentials` (INI-style, mode `0600`). With `setup --from-env`, an unwritable or read-only HOME (`EACCES`, `EPERM`, or `EROFS` while saving credentials) produces a stderr warning and setup continues using `TESTSPRITE_API_KEY` for this session. Its JSON summary includes `credentials: { persisted: false, source: "env" }`; successful authentication does not mean the key was saved. Keep `TESTSPRITE_API_KEY` available in every shell/process that invokes the CLI. Agent installation still needs a writable destination; use `--no-agent` when only session authentication is needed. Other setup errors still fail. See [Configuration](#configuration) for profiles, environment overrides, and scopes.

`testsprite setup --debug` reports display-only identity/profile lookup failures and ignored non-JSON agent-install output on stderr. These diagnostics leave setup's existing fallback behavior and JSON summary intact; without `--debug`, these fallbacks remain silent.

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
testsprite setup

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
testsprite agent list               # catalog: all 8 targets × skills and where each lands
testsprite agent status             # check installed skills against this CLI version
```

Supported targets: `claude` (GA), `codex` (experimental), `cursor` (experimental), `cline` (experimental), `antigravity` (experimental), `kiro` (experimental), `windsurf` (experimental), `copilot` (experimental).

Omitting `--target` installs for the agents the project shows it uses — the calling agent when the environment names one, together with every agent whose own configuration is already in the repo. Both kinds of evidence count, so being called by one agent does not limit the install to that agent. A non-interactive shell (CI, agent subprocess) installs that set with an `[info]` note on stderr naming it; a terminal prompts with it pre-filled — press enter to accept, or give a comma-separated list to narrow it. An unrecognised name is refused outright (exit 5) and nothing is written; re-run to try again. With nothing detected it falls back to `claude` and says so.

`setup`'s prompt is deliberately more forgiving than this one — it re-asks on an unrecognised name and takes `none` to skip. Neither command writes anything before its prompt, so the difference is not about what a refusal would leave behind: `setup` is the onboarding command, usually run once and often by an agent, where a re-run costs a whole round trip; `agent install` is a repair command already being run by hand, where re-running it is the obvious next thing to do. Both prompts accept a name in any case (`Cursor` and `cursor` are the same answer).

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

The text table includes `DEFAULT ENV` and `ENVS` (select with `--columns defaultenv,envs`). Missing values show `-`; a reported zero environment count shows `0`. JSON includes `defaultEnvironment: string | null` and `environmentCount: number` only when the server supplies them.

#### `testsprite project get <project-id>`

Get a single project by id. Project ids look like `proj_xxxxxxxx` and come from `project list`.

```bash
testsprite project get proj_xxxxxxxx --output json
testsprite project get proj_xxxxxxxx --dry-run --output json
```

When the server supplies an environment summary, text detail shows `defaultEnv:  <name>` and `envs:        <count>`, with a `testsprite project env list <project-id>` hint for a positive count. A reported null default shows `-`; older servers and V2 projects omit both lines. JSON preserves the server's fields without adding missing values.

#### `testsprite test list --project <id>`

List tests under a project. `--project` is required. Cursor-paginated. Use `--env <name>` to show each frontend test's status in that environment; a test without a result there shows `ready`. Text output has an `ENV` column for the environment that supplied each row's status (`-` when absent). JSON retains `status` and passes through `statusByEnvironment` and `headlineEnvironment` when the backend provides them.

```bash
testsprite test list --project proj_xxxxxxxx --output json
testsprite test list --project proj_xxxxxxxx --type frontend --created-from portal
testsprite test list --project proj_xxxxxxxx --env staging
testsprite test list --project proj_xxxxxxxx --dry-run --output json
```

Common flags:

- `--type <frontend|backend>` — filter by test type.
- `--created-from <portal|mcp>` — filter by where the test was authored.
- `--status <list>` — filter by status.
- `--env <name>` — select the environment used for frontend status (name is case-sensitive).
- `--page-size`, `--starting-token`, `--max-items` — pagination, same shape as `project list`.

#### `testsprite test get <test-id>`

Get a single test by id. Test ids look like `test_xxxxxxxx` and come from `test list`. For frontend tests, text output shows the headline environment when a result identifies one. Backend tests echo their dependency declarations — `produces` / `consumes` / `category` — when present. When a per-test timeout is set, text output includes `Step timeout: <N> ms (applies to every step)`; the line is omitted when the value is absent or cleared.

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

List the **latest run's steps** for a test (with screenshot / DOM-snapshot pointers). Use `--run-id <run-id>` for a specific run; that run must belong to the named test (otherwise exit 4). An empty latest run does not fall back to old steps: inspect `test result <test-id> --history` and choose an earlier run explicitly. Bare reads auto-paginate; older backends may still return cumulative steps, so always pin `--run-id` when comparing runs. The run-scoped response retains `{ items, nextToken: null }`.

```bash
testsprite test steps test_xxxxxxxx --output json
testsprite test steps test_xxxxxxxx --run-id run_01hx3z9p8q4k2y7a --output json
testsprite test steps test_xxxxxxxx --dry-run --output json
```

Common flags: `--page-size`, `--starting-token`, `--max-items` — same shape as the other lists.

#### `testsprite test result <test-id>`

Get the latest result for a test — status, started / finished timestamps, video and failure-analysis URLs, summary counts (`passed / failed / skipped`), and correlation fields (`snapshotId`, `runId`, `codeVersion`). With `--include-analysis`, the response also carries an inline `analysis` block (root-cause hypothesis, recommended fix target, failure kind). Backend tests additionally surface the run's captured stdout (`apiOutput`) and Python traceback (`trace`): full content under `--output json` (and in `result.json` / `failure.json` inside failure bundles); text mode prints a bounded 20-line tail of each with a byte count.

With `--history`, each row also carries the environment the run used: an **ENV** column shows the environment name, or `—` for rows that predate environments. A run-time `--target-url` can reuse an existing same-origin environment or use a temporary one; `--env` can supply settings while the browser visits the override URL. The `targetUrl:` detail line reports the run's target. `--env <name>` filters the history to runs on that environment (server-side; only with `--history`). The latest-result view prints an `environment:` line for the same reason. JSON consumers get `environment: { id, name } | null` on every run/result payload and `targetUrl`; `targetUrlSource` is `null` on a V3 row.

```bash
testsprite test result test_xxxxxxxx --output json
testsprite test result test_xxxxxxxx --include-analysis --output json
testsprite test result test_xxxxxxxx --dry-run --output json
```

With `--history`, the command lists a test's **prior runs** instead of the latest result — `{ runs: [...], nextCursor }`, where each run carries `runId`, `status`, `source` (`cli | portal | mcp | schedule | github_action`), `isRerun`, `createdFrom`, timestamps, `codeVersion`, and `failureKind`. Filter with `--source <src>` and `--since <24h|7d|ISO>`; paginate with `--page-size` (1–100, default 20) and `--cursor`. For one run's detail use `test wait <run-id>`; for its failure bundle use `test artifact get <run-id>`.

`--history --env <name>` naming an environment that does not exist (or was soft-deleted) is a `VALIDATION_ERROR` (exit 5) that names the requested value and the project's current environment names — it never silently falls back to unfiltered history. A name that DOES exist but has no matching runs is an ordinary empty result (exit 0), same as `--history` with no filter finding nothing. `--env` is a V3-only filter: on a V2 (legacy) project the server returns `UNSUPPORTED` (exit 7) before reading any history, with a `nextAction` pointing at migrating the project — the same shape `test list --env` uses.

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

Create a new test. Backend tests use `--code-file` (agents supply backend code directly); frontend tests use either `--code-file` or `--plan-from` (see [Plan file format](#plan-file-format)). With `--run --wait`, the CLI chains create → trigger → poll in a single invocation. `--step-timeout <ms>` sets a per-test step timeout from 1 to 60000 milliseconds on the code-file path. Backend tests can declare wave-ordering dependencies at create time — `--produces <var>` / `--needs <var>` (repeatable) and `--category <setup|main|teardown>` — and amend them later via `test update`.

`--plan-template` prints the canonical minimal plan-file skeleton to stdout and exits — pure-local, no network/credentials, ignores every other flag. The exact same example is embedded in `test create --help`.

```bash
# Backend test from a code file
testsprite test create --project proj_xxxxxxxx --type backend --name "Login API" \
  --code-file ./login.py

# Frontend test from a code file with a per-test step timeout
testsprite test create --project proj_xxxxxxxx --type frontend --name "Checkout" \
  --code-file ./checkout.py --step-timeout 45000

# Frontend test from an agent-supplied plan-steps document; trigger + wait inline
testsprite test create --plan-from ./checkout.plan.json --type frontend \
  --run --wait --timeout 600 --output json

# Print the plan-file skeleton, edit it, then create from it
testsprite test create --plan-template > plan.json

# Dry-run prints the canned wire envelope
testsprite test create --plan-from ./checkout.plan.json --dry-run --output json
```

`--plan-from` owns the complete test definition and does not support this setting; a supplied `--step-timeout` is warned about and ignored. Set it later with `test update --step-timeout <ms>`.

#### `testsprite test create-batch`

Bulk-create frontend tests from a JSONL plan-steps file (or a directory of plan files with `--plan-from-dir`). Optional `--run --max-concurrency <N>` fans out triggers. Without `--wait`, each run is dispatched (`status: "queued"`) and the command exits 0 when every trigger is accepted — mirroring single `test run` without `--wait`; a trigger error still exits non-zero. With `--wait`, it polls every run to terminal and exits non-zero if any run does not pass.

```bash
testsprite test create-batch --plans ./plans.jsonl --run --max-concurrency 4 --output json
testsprite test create-batch --plan-from-dir ./plans/ --dry-run --output json
```

#### `testsprite test update <test-id>`

Update test metadata (name, description, priority), set a per-test timeout with `--step-timeout <ms>`, or restore the execution-engine defaults with `--clear-step-timeout`. The two timeout flags are mutually exclusive. For **backend tests**, dependency declarations are also editable: `--produces <var>` / `--needs <var>` (repeatable) and `--category <setup|main|teardown>`. Updated declarations and a numeric step timeout are echoed back by `test get`.

```bash
testsprite test update test_xxxxxxxx --name "Renamed test" --description "Updated"
testsprite test update test_xxxxxxxx --step-timeout 30000
testsprite test update test_xxxxxxxx --clear-step-timeout
testsprite test update test_be_xxxx --produces session_token --category setup
testsprite test update test_xxxxxxxx --dry-run --output json
```

**Per-test step timeout.** This is a frontend-test setting. The value is 1–60000 milliseconds and the execution engine applies it to **every step** of that test. It is unrelated to `test run --timeout`: that flag is the polling deadline under `--wait` (600 seconds by default, 1200 with `--local`). Reaching it leaves an ordinary run executing, but the CLI cancels an owned `--local` run by default before closing its tunnel. An adopted run normally detaches, except that it cancels its own run if the tunnel owner disappears. See [local timeout and ownership rules](#local-frontend-testing-and-tunnels). Test code bakes timeout values in when code is generated, so changing this setting affects runs that generate or regenerate code; it does not rewrite or change replays of previously stored code. `--clear-step-timeout` sends `null` and restores the execution-engine defaults. Because a larger per-step value can lengthen a run, successful set operations print a stderr warning to raise `test run --wait --timeout <s>` when needed.

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

Manage projects from the CLI. Both validate `--url` before network access; supported loopback origins follow the same stored-URL path as `--local`. Projects have **no description field** — `--description` is rejected client-side with a validation error (descriptions live on tests: `test create --description`). `project update` accepts `--name`, `--url`, `--username`, `--password`, `--password-file`, `--instruction`, `--test-id-attributes`, and `--clear-test-id-attributes`.

`project update --url` and credential flags edit the existing default environment. When the server reports the change, text output names that environment and the fields applied; an older server keeps the previous output. If no default environment can be resolved, the server returns a conflict with the `project env set-default` next step.

`--test-id-attributes <list>` (also on `project create`) is the project's locator attribute priority list: a comma-separated, ordered set of DOM attributes your app uses as stable test hooks (e.g. `data-element,data-testid`). The execution engine tries them in that order before any other locator strategy when it exports test code, so a tagged element is exported as `page.locator('[data-element="nav.team-selector.trigger-btn"]')`; an attribute whose value is not unique on the page is skipped. `--clear-test-id-attributes` removes the list (engine default: `data-testid`). V3-native projects only — on a V2-mirrored project the backend answers `PRECONDITION_FAILED` (`test_id_attributes_native_only`). Against a backend that predates the field, the CLI answers `UNSUPPORTED` (exit 7, `test_id_attributes_unsupported_backend`) instead of passing through the server's generic 400.

```bash
testsprite project create --type frontend --name "Checkout" --url https://staging.example.com
testsprite project update proj_xxxxxxxx --name "Checkout v2"
testsprite project update proj_xxxxxxxx --test-id-attributes data-element,data-testid
```

**Bootstrap a local frontend project (V3).** Start your app, then create the project without a public deployment:

```bash
testsprite project create --type frontend --name <name> --local <port> [--skip-preflight]
testsprite test create --plan-from ./checkout.plan.json --project <project-id>
testsprite test run <test-id>
```

`project create --local` stores `http://localhost:<port>`. Alternatively, pass `--url http://localhost:<port>`, `--url http://127.0.0.1:<port>` or `--url http://[::1]:<port>` (an optional trailing `/` is preserved). Loopback stored URLs must use HTTP, an explicit port and no path; HTTPS, missing ports, other `127.x` hosts, unspecified addresses, LAN/RFC1918, link-local and metadata addresses remain refused. `--local-host` still overrides the shorthand host, but is deprecated and hidden from project/environment help; prefer an explicit URL. Existing rows retain their host spelling. `project get` and `project list` expose `originMode: 'local'` in JSON, while text output shows `(Local)`. Loopback creation is frontend-only; `--local` and `--url` remain mutually exclusive. The port is probed before creation unless `--skip-preflight` is given. V2-only accounts receive exit 7 (`local-origin-requires-v3`).

Creation performs **no exploration or plan generation**. `test plan generate --project <project-id>` on a local project is refused **before charge**, with exit 6 and guidance to use `test create --plan-from … --project <id>` followed by `test run <test-id>`. Author a plan using the [plan file format](#plan-file-format), capture the created test id, and run it through the tunnel.

Portal runs of a local project are **BLOCKED for free** until you set a public URL:

```bash
testsprite project update <project-id> --url https://staging.example.com
```

A case previously run through a tunnel also has its own local-target history; see [retargeting a local case](#local-frontend-testing-and-tunnels) when running that case without a tunnel.

#### `testsprite project env list | get | create | update | delete | set-default`

An **environment** is a named bundle of "how to reach and log in to the app": a URL, a test account (username + password), auto-auth and OTP settings. A project with configured environments can have a default environment — it is what `project create --url` / `project update --url --username --password` have always been editing, and what a run without `--env` or a run-time target uses. `project env` manages additional ones by name (unique within the project), and `test run --env <name>` / `test rerun --env <name>` select one.

```bash
# What does this project have?
testsprite project env list proj_xxxxxxxx
testsprite project env get proj_xxxxxxxx staging

# A second deployed target with its own test account
testsprite project env create proj_xxxxxxxx --name staging --url https://staging.your-app.com \
  --username qa@your-app.com --password-file ./staging-pw.txt

# An app that only runs on your own machine: name it by its port, the same way as `project create --local`.
testsprite project env create proj_xxxxxxxx --name local-dev --local 5173 \
  --username dev@your-app.com --password-file ./local-pw.txt
testsprite test run test_xxxxxxxx --env local-dev

# Change, rename, promote, remove
testsprite project env update proj_xxxxxxxx staging --url https://staging2.your-app.com
testsprite project env update proj_xxxxxxxx staging --rename preview
testsprite project env update proj_xxxxxxxx preview --clear-credentials
testsprite project env update proj_xxxxxxxx preview --var REGION=west --var TENANT=trial
testsprite project env set-default proj_xxxxxxxx preview
testsprite project env delete proj_xxxxxxxx local-dev --confirm
```

`create` needs exactly one of `--url <url>` or `--local <port>`. Supported HTTP loopback origins are ordinary environment URLs: `localhost`, `127.0.0.1` and `[::1]`, with an explicit port and no path. `--local` is a shorthand for `http://localhost:<port>`; the deprecated `--local-host` override remains accepted. The port is probed first unless `--skip-preflight` is given. `update --local <port>` or `update --url http://localhost:<port>` changes the stored origin; existing URLs are never normalized or merged. Run a saved environment with `test run --env <name>`: its loopback URL opens a tunnel automatically. Passwords come from `--password-file` and are never printed back. `delete` refuses the default environment; deleting any other is a soft delete, so run history keeps naming it.

`get` shows the environment id, name, URL, default status, safe login mode and variables without a password. An older server without the get route returns a clear `UNSUPPORTED` error (exit 7). Portal-only login modes are shown as managed in Portal. `--output json` returns the server response, including the environment id and `variables`; text `list` stays compact. `update --clear-credentials` removes the username and password and disables account login; it cannot be combined with `--username`, `--password` or `--password-file`. Portal-only login settings must be changed in Portal.

Use repeatable `--var KEY=VALUE` on `env create` and `env update` to set frontend environment variables. Update merges by key. The first `=` separates key from value, so `--var TOKEN_HINT=a=b` stores `a=b`. Keys must match `^[A-Za-z_][A-Za-z0-9_]{0,63}$` and cannot be `url`, `username`, `password`, `authType`, `credential`, `memory_hints`, `rerun_context`, `__proto__`, `constructor` or `prototype` (case-sensitive). At most 50 keys fit in one environment; a value is limited to 4096 UTF-8 bytes and the total to 32 KiB. Values are plain text in `get` and JSON, so do not use variables for secrets.

Create and update require the server response to confirm requested `--var` values; update also requires confirmation that `--clear-credentials` removed the stored account. If an older server ignores either flag, the CLI exits nonzero and asks you to upgrade or retry. A mixed update's URL may already have changed before that error, so inspect the environment before retrying.

##### Temporary environments for run-time targets

For a frontend run with `--target-url` and no `--env`, TestSprite reuses an environment that already points at the URL's origin. Otherwise a supporting backend creates a temporary environment that clones the default environment's sign-in configuration; an older backend retains its previous temporary-environment behavior. Temporary environments are hidden from `project env list`, do not count toward the environment limit, and are deleted when the run finishes; users cannot create them directly. With `--env <name> --target-url <url>`, the named environment's login and other settings are used against the override URL. The backend refuses a login-once, OTP, or manual-login environment when its origin differs from the target (`PRECONDITION_FAILED`, exit 6). Backend tests still use the URL in their generated code.

#### `testsprite project sign-in get | set`

Choose how runs sign in to one environment. `--env <name>` selects a named environment; omitting it uses the project default. `get` prints the mode, account password status, OTP channels and provisioned inbox/phone, or the SSO session status. `--output json` returns the server response unchanged. Text mode warns that runs **will NOT be signed in** when a manual environment has no valid captured session.

```bash
testsprite project sign-in get proj_xxxxxxxx --env staging
testsprite project sign-in set proj_xxxxxxxx --env staging --mode account \
  --username qa@your-app.com --password-file ./staging-pw.txt
testsprite project sign-in set proj_xxxxxxxx --env staging --mode public
testsprite project sign-in set proj_xxxxxxxx --env sso --mode manual --session-ttl 3600
testsprite project env create proj_xxxxxxxx --name otp --url https://staging.your-app.com \
  --sign-in otp --otp-channel email,sms
testsprite project env set-default proj_xxxxxxxx otp
```

Modes are `public`, `account`, `otp`, and `manual`; aliases `none`, `credentials`, and `sso` map to `public`, `account`, and `manual`. OTP is chosen when creating an environment and cannot be switched on or off later: create a new environment and optionally make it default. `--otp-channel` accepts `email` and `sms` (comma-separated or repeated) and defaults to email. SSO login itself happens once in the Portal under Project → Settings → Environments → the environment name → Log in; the CLI can choose manual mode and report session status but cannot capture the login. SSO (`manual`) selection is behind a per-account feature flag; `--mode manual` returns `FEATURE_GATED` (exit 13, `manual-login-disabled`) when it is off. Manual `--session-ttl` accepts 1–2592000 seconds or `never`; omitting it lets the server retain an existing manual TTL or use its 1-hour default. Local environments support only public and account sign-in. A temporary environment (created for one `--target-url` run) has no settable sign-in, so `set` refuses it with exit 5; create a permanent environment for that URL instead. An SSO or OTP environment keeps no username or password, so `project env update --username/--password` (and `project update --username/--password` when it is the default environment) on one exits 6 and points at `sign-in set`; `--local` on one exits 6 too, and a temporary environment refuses credentials with exit 5. An environment with no stored account takes `--username` and `--password` together or not at all (exit 5), on `project env create` without `--sign-in` and on `project env update`; changing one half of a stored account is still a rotate. The CLI cannot tell whether a captured SSO session still fits a changed address: `project env update --url` on an SSO environment reminds you to log in again in the Portal if the site changed. Both writes accept `--idempotency-key` and support global `--dry-run` without reading password files.

For `project sign-in get/set` and `project env create`, exit **0** means success; **3** means authentication or scope failure; **4** means the project or environment was not found; **5** means invalid flags or fields (including a locally rejected OTP/manual `--local` combination); **6** means a server `PRECONDITION_FAILED` refusal (including OTP fixed at creation or unsupported local sign-in) or a write conflict; **7** means `UNSUPPORTED` (V2 environments or manual/OTP in BYOC); and **13** means `FEATURE_GATED` (manual login disabled). Shared request failures can also return **10** (`UNAVAILABLE`), **11** (`RATE_LIMITED`), or **14** (`CLIENT_TOO_OLD`). Inspect the error `code` and `details.reason` in JSON mode to distinguish causes that share an exit code.

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

### Generate commands

Ask TestSprite to write the tests for you, instead of authoring every plan by hand. `test plan generate` produces test-case **proposals** for a project and holds them for your review; `test plan accept` turns the ones you keep into real tests. `project docs upload` supplies the source material generation reads.

**Everything stays on the server.** Proposals are staged in your project, not written to your disk — there is no `--out`, no plan file to manage, and no prompt to answer. You review them in the table `generate` prints (or in the Portal) and then accept.

**Only the missing work runs.** `generate` checks what the project already has and picks up from there: a brand-new frontend project gets explored, gets a feature map, then gets proposals; an already-explored project skips straight ahead. Re-running never redoes a stage that is already done.

Requirements: an account on the **V3 platform** (an account still on the older platform gets a clear message and exit 6 — generate plans in the Portal until the migration reaches you), and the `write:projects` scope for `generate`, `write:tests` for `accept`. `--dry-run` makes no network calls at all.

#### `testsprite test plan generate`

Runs whichever pipeline stages the project is still missing — exploration, then the feature map, then the proposals — and prints the staged batch. A fresh frontend project runs all three; an already-explored project skips ahead.

```bash
testsprite test plan generate --project proj_xxxxxxxx
testsprite test plan generate --project proj_xxxxxxxx --output json
testsprite test plan generate --project proj_xxxxxxxx --dry-run       # no network
```

```
$ testsprite test plan generate --project proj_abc123
[hint] 3 stages: exploration, strategy, proposals. Takes minutes. Ctrl-C is safe; re-run to continue.
[warn] exploration signs in only with the test account stored on the project's default environment. If your app requires login and no test account is configured, the agents will explore only the public pages — a shallow result from a stage that still runs and still bills. For signed-in coverage, store a test account first: testsprite project update proj_abc123 --username <user> --password-file <path>
stage 1/3 exploration done 4m48s
stage 2/3 strategy done 1m12s
stage 3/3 proposals done 55s
2026-08-18T20:48:02.117Z 12 proposals staged

12 test-case proposals staged for review (credits used: 6, balance: 144)

  #  ID       TITLE                       FEATURE        PRIORITY  TYPE
  1  prop_1   Login happy path            auth/login     p1        frontend
  2  prop_2   Login wrong password        auth/login     p1        frontend
  …

next
  review the list above, then:  testsprite test plan accept --project proj_abc123
  accept a subset with:         testsprite test plan accept --project proj_abc123 --only <id ...>
  (or review visually in the Portal before accepting)
```

The timestamped progress line is a **single line overwritten in place** (shown above at one instant); as stages advance it reads `generating strategy… (52s)`, then `proposing tests… (31s)`. It appears only in an interactive terminal — see the first bullet below.

Flags:

- `--project <id>` — required. V3 ids work directly; older project ids resolve through the migration bridge.
- `--timeout <seconds>` — total wait budget, default **1800**. Exploration genuinely takes minutes, which is why this default is far larger than the run commands'.
- `--idempotency-key <token>` — retry namespace for the trigger; auto-minted per invocation otherwise.

Behavior worth knowing:

- **Progress is a single stderr line**, updated in place, and only in an interactive terminal. `--output json` and CI runs get no ticker — just the final result object on stdout.
- **Re-running joins a stage already in progress.** If a stage is already running — including one you started in the Portal — the command waits for it instead of failing or starting a second one.
- **If proposals are already staged, nothing is started.** The command prints the existing batch and says so. Regenerating a batch you don't like is a Portal action for now: accept or discard the staged batch there first.
- **Ctrl-C pauses, it does not cancel.** The stage in progress finishes on its own; the stages after it wait until you run the command again. Exit 130/143/129; stdout still gets a partial `{ projectId, status: "running", stagesRemaining, … }` object so a redirected file is never empty, and stderr says which stage you paused in and how many are left.
- **On `--timeout` (exit 7)** the same partial is printed with a `Continue:` line; running the identical command again picks up where it left off. Raise `--timeout` if you want one run to cover every stage.
- **Stage progress lines.** In text mode one `stage i/N <name> done <elapsed>` line is printed as each stage finishes and stays in scrollback; the live progress line (`exploring app… (resources 3/8, 4m10s)`) redraws in place beneath it on a terminal and is cleared before each stage line is written, so the two never share a row.
- **A stage that fails server-side exits 1** with the server's error. Stages that already completed stay completed, so a re-run resumes rather than restarts.
- **The result line reports what this invocation actually charged** (`credits used: N, balance: M`), from the server's own figures. It is best-effort — against a backend that cannot supply it the line simply omits those numbers, and a run that charged nothing (for example a re-run that found proposals already staged) omits `credits used` rather than repeating old spend. `testsprite usage` shows your balance any time.
- **In `--output json`, read `creditsUsedThisInvocation` for this run's spend** — a top-level number that is this invocation's charge alone, not the project's lifetime total. It is `null` when the spend can't be determined (the billing read was unavailable at either end of the run); a script must treat `null` as "unknown", not as zero. Prefer it over summing `credits.charged[]`, which is the project's cumulative ledger.

When a prerequisite is missing the error names the exact fix rather than prompting:

```
$ testsprite test plan generate --project proj_new789
Error: The project's environment has no URL, so the app cannot be explored.
Set the app URL first: testsprite project update proj_new789 --url https://staging.your-app.com
requestId: req_20260813_a1b2c3
# exit 6
```

The three preconditions and their fixes: no environment URL on a frontend project (`project update … --url`), no processed input sources on an API project (`project docs upload`, below — or add sources in the Portal; a source you just added may still be processing, so retrying shortly can also be the answer), and an account not yet on the V3 platform (use the Portal for now).

One warning fires before browser exploration starts: exploration signs in only with the test account stored on the project's default environment, so if your app requires login and no test account is configured, the agents explore public pages only — a shallow result from a stage that still ran. It warns rather than blocking, because the CLI cannot tell whether your app needs sign-in. The remedy is in the CLI: `testsprite project update <project-id> --username <user> --password-file <path>` stores the account and turns sign-in on for exploration (both flags are required together).

#### `testsprite test plan accept`

Converts staged proposals into real test cases — all of them, or a subset.

```bash
testsprite test plan accept --project proj_xxxxxxxx
testsprite test plan accept --project proj_xxxxxxxx --only prop_2 prop_5 prop_9
testsprite test plan accept --project proj_xxxxxxxx --only prop_2,prop_5
```

```
$ testsprite test plan accept --project proj_abc123
12 proposals accepted — 12 test cases created

next
  testsprite test list --project proj_abc123
  testsprite test run --all --project proj_abc123 --wait
```

- `--only <ids...>` takes the ids from the `generate` table, space- or comma-separated. **Accepting a subset discards the rest** — the staging area is cleared either way — and the output states how many were discarded.
- A `--only` that names **any unknown id** — even alongside valid ones — is a validation error (exit 5) and **the request is never sent**; the message names the unknown ids alongside the ids that are actually staged. The strictness is a deliberate guard, not pedantry: a wrong id usually means the staged batch is not the one you reviewed, and an empty selection means "reject everything" to the server, which would destroy the batch.
- Nothing staged → exit 6, pointing at `test plan generate`. Scripts can tell "accepted" from "nothing to accept".
- **API test code is generated when the tests first run**, not at accept, so that note appears only when API cases were among the ones you accepted. From here the ordinary `test list` / `test run` commands take over.
- Editing a proposal before accepting is not available from the CLI yet — accept the ones you want, then revise in the Portal.

#### `testsprite project docs upload <file>`

Upload an API spec or a PRD as a project **source**. Generation reads these sources to build the feature map, so for an API project this is usually the first step — without any source, `test plan generate` stops at "no processed inputs". Requires `write:projects`.

```bash
testsprite project docs upload ./openapi.yaml --project proj_xxxxxxxx --role api-doc
testsprite project docs upload ./product-spec.md --project proj_xxxxxxxx --role prd --name "Checkout PRD"
testsprite project docs upload ./openapi.yaml --project proj_xxxxxxxx --dry-run
```

```
$ testsprite project docs upload ./openapi.yaml --project proj_new789 --role api-doc
uploaded openapi.yaml (48 KB) — processing started
note: generation can use this source once processing and embedding finish
      (check with `testsprite test plan generate` — it says if inputs are still processing)
```

- `--role api-doc|prd` — defaults to `api-doc`. Nothing is inferred from the project type.
- **Cost:** an `api-doc` upload is free. A `prd` upload bills **0.5 credits** when the document is registered — PRDs are embedded for retrieval, and the embedding is the charge. The command itself prints no spend line today, so this is the disclosure.
- `--name <display-name>` — defaults to the file's basename. It only changes the display name, not the stored file name.
- **A document is stored under its file name, so uploading a different file with the same name replaces the earlier one.** This is what makes re-uploading the _same_ file safe (it updates in place rather than piling up duplicates), but it also means `./v1/api.yaml` and a later `./v2/api.yaml` collide on `api.yaml` and the second silently replaces the first — the folder is not part of the stored name. Give distinct files distinct names if you need to keep both. This is platform behavior (the same as the Portal), not specific to the CLI.
- The upload is a three-step flow (mint a signed upload URL, send the bytes, register the document). The file is **streamed**, never read into memory, so large specs upload at constant memory cost. The local file is only read — nothing is written back to disk.
- **If the upload step fails (exit 10), nothing was registered**: re-run the command and it mints a fresh URL. Signed URLs expire after an hour, so a re-run is the fix rather than a retry of the same URL.
- **If the register step fails, the bytes already landed** — the error says so, and re-running the whole command is safe: the server stores the document by its storage key and replaces rather than duplicates it. One caveat: a retried register re-runs the processing pipeline (and for a `prd` document, the embedding compute), but the 0.5-credit embedding charge is **idempotent per document** — the billing ledger deduplicates it, so a retry is never billed twice. You pay the 0.5 credits at most once per document, whether the first register landed or the retry did.
- `--dry-run` reads nothing but the file's size and prints the three steps it would take. No network.

There is no `project docs list` or `docs delete` yet; the Portal is the place to review or remove a project's sources.

### Run commands

Require the `run:tests` scope.

#### `testsprite test run <test-id>`

Trigger a run for a test. Without `--wait`, prints `{ runId, status: "queued", enqueuedAt, codeVersion, targetUrl }` and exits 0. With `--wait`, polls until terminal — exit 0 on `passed`, exit 1 on `failed | blocked | cancelled`, exit 7 on `--timeout`. After the trigger response, stderr immediately prints `Run <runId>` and, when the response supplies a dashboard/execution URL, `Dashboard: <url>` — before polling, including with `--output json`. Keep that id even if the process is later interrupted; stdout remains the normal JSON result channel. On timeout, stdout still receives a partial run object with `runId` before exit 7. Ordinary runs and adopted tunnels whose owner remains alive get a `test wait <run-id>` hint; owned `--local` runs and adopted runs whose owner disappears are cancelled by default (see below).

`--all --project <id>` runs every test in the project in wave order. Add `--target-url <url>` to point its frontend tests at a run-time target. On the current unified engine that means **all tests, frontend and backend**; on the legacy backend-only engine, frontend tests can't run — they are skipped and enumerated in `skippedFrontend` with a stderr advisory.

`testsprite test run list` — a literal `list` where a test id goes — is a usage error (exit 5), not a run against a test named "list": there is no `test run list` subcommand. It points you at `test result <test-id> --history`, which lists a test's prior runs.

The server controls whether a fresh run auto-heals drifted generated code by default. When healing is enabled, the agent re-authors stale code and runs the new version instead of replaying a script that can only fail. Healing saves the new code as the test's stored version.

When healing is on only because it is the server's default, it does not re-author code **you** wrote (`test code put`, a file passed to `test create --code-file`, or a hand-edit in the portal): that code is run as written. A healed verdict can mask a real regression, so use `--no-auto-heal` to ask the server for a strict stored-code replay when available. The flag is accepted by `test run`, `test run --all`, and `test rerun`; its effect depends on the command and server.

Stored-code replay is not available in every workspace. Where unavailable, the server rejects `--no-auto-heal`. Where replay is available but a frontend test has no replayable stored code yet, the server can refuse the run with `no_stored_code` rather than authoring it; run the test once without the flag first. `test rerun --no-auto-heal` applies to frontend reruns and is ignored for backend reruns.

```bash
# Trigger and return immediately
testsprite test run test_xxxxxxxx --output json

# Trigger against a run-time URL and wait for terminal status
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

**GitHub-native CI output** (contributed in [#264](https://github.com/TestSprite/testsprite-cli/pull/264)): when `GITHUB_ACTIONS=true`, any `test run --wait` (single test or `--all`), any batch `test rerun --wait`, and `testlist run --wait` additionally emit one workflow-command line per non-passed run (annotating the PR checks tab — `::error::` for a dispatched run that failed or timed out, `::warning::` for a test that never dispatched) and append a Markdown results table to the job summary (`$GITHUB_STEP_SUMMARY`). Pass `--gh-output` to force the annotations outside Actions (previewable locally), and `--summary-file <path>` to also write the reduced machine summary JSON (`{total, passed, failed, skipped, timedOut, runs[]}`). Everything is written even when the command exits non-zero — including a batch where nothing dispatched at all (every test already in flight → exit 6, or every test rate-deferred → exit 7), which still surfaces its verdict in CI rather than failing silently. Every write is best-effort — a failed write never changes the exit code. Tests that never dispatched (rate-deferred, conflicted, not found) appear as non-passed rows counted under `skipped` — never under `failed`, so the artifact always agrees with the exit code — and a partial batch still cannot read as all-passed. Annotation and table content is escaped, so run-error text cannot inject workflow commands or break the table.

**`--target-url` with `--all` (the CI deployment gate).** The flag applies to a batch too: `test run --all --project <id> --target-url https://pr-42.preview.example.com` runs every **frontend** test in the project against that URL — the shape a PR gate needs, where the URL is this PR's preview deployment and differs on every run. The project's configured environment is never modified; the URL is applied as a per-run override, exactly as on a single run. A **backend** test is unaffected (its base URL is baked into its generated code) and the CLI prints an advisory saying so. The reachability preflight runs once for the whole batch before anything is dispatched or billed; use `--skip-preflight` if the preview is still warming up. If the server does not echo the exact URL, including on a deferred retry, the command exits **7** (`target-url-not-honored`) after attempting to cancel only the runs accepted in the unconfirmed dispatch. Runs confirmed by an earlier dispatch are reported as not awaited and remain running. Cancellation and refunds are best-effort; the CLI prints each refund status returned by the server. With `--wait`, this failure also writes the requested JUnit and machine summary files, GitHub annotations, and the job summary.

`--target-url` accepts public URLs and supported loopback URLs such as `http://localhost:3000`, `http://127.0.0.1:3000` and `http://[::1]:3000`. A loopback target on `test run` uses the same tunnel path as `--local <port>` with that host. Other private, unspecified, link-local and metadata addresses remain refused. Tunnels are frontend-only and need `run:tunnel`; a scope refusal names the missing scope (exit 3). Existing keys receive it on backend v0.18.0 or later unless deliberately narrowed.

**`--env <name>` — the origin and sign-in configuration.** Select a named environment, or omit it for the project default (see [`project env`](#testsprite-project-env-list--get--create--update--delete--set-default)). A saved loopback URL automatically opens a tunnel on frontend `test run` (one/many/`--all`), `test rerun`, `test create --run`, `test create-batch --run` and `testlist run`. The stored URL is sent verbatim, so `localhost`, `127.0.0.1` and `[::1]` remain distinct origins. `--no-wait` disables automatic tunneling; drop it to run through a tunnel. If the environment list cannot be read, the CLI sends the previous request and renders the server's refusal. Backend tests keep their previous cloud behavior.

`--target-url` and `--local` can supply an ad-hoc origin while `--env` supplies its sign-in configuration and run attribution. When no saved origin matches and no `--env` is selected, a supporting backend clones the project default's sign-in configuration into a temporary environment. Explicit `--local` can use a public environment's sign-in configuration on a new backend; an older backend's refusal is rendered verbatim and the tunnel is closed. Unknown environment names remain validation errors with the available names. `--env` is also accepted by `--all` and `test rerun`.

**Reachability preflight (refuse before charge).** For a public `--target-url`, the CLI probes **before dispatching** (and before anything is billed): a DNS resolve plus a lightweight HTTP request. Loopback tunnel targets use a TCP probe of the stored host and port instead. A confirmed-dead target — DNS `NXDOMAIN`, connection refused, or a `502`/`503`/`504` gateway error (the signature of a tunnel that has gone away) — is refused with a validation error (exit 5) instead of dispatching a run that can only fail against a URL nobody is serving. A resolved address that lands in private/loopback/link-local space is always refused (the hostname passed the literal check but actually points somewhere unreachable from the runner). Ambiguous signals — a timeout, a TLS error, an odd status — only produce a stderr warning and never block; behind a configured HTTP(S) proxy, a local DNS failure is also downgraded to a warning, since resolution really happens at the proxy. `--skip-preflight` (on `test run`, `test create`, and `test create-batch`) skips these probes; metadata reads needed to resolve an environment still occur. Note: for a backend test the probe is a heuristic (the test's own base URL is baked into its code) — reach for `--skip-preflight` if a refusal surprises you there.

The `[advisory]` about `--target-url` on V3-routed accounts is now **response-driven**: the CLI reads the run's actual trigger response rather than guessing from account flags, so it fires only when the override genuinely did not take effect (newer backends apply `--target-url` to fresh frontend runs on V3; older ones ignore it and the advisory says so). The CLI auto-mints an idempotency key (printed to stderr under `--output json`, `--verbose`, or `--debug`); pass `--idempotency-key <uuid>` to control it explicitly.

**`--wait` exit-code precedence (shared across `test run --all`, batch `test rerun`, and `testlist run`).** When a fan-out poll ends with a mix of outcomes, the process exit code is resolved through one shared precedence table — batch-wide non-retriable first: auth (3) and client-too-old (14), then per-run non-retriable (12 insufficient credits, 13 feature-gated), then per-run errors (4/5/6), then transient (11 rate-limited, 10 unavailable), then timeout (7), then the generic failure (1). A per-member poll error now surfaces its real code instead of folding into 7/1. Batch conflicts are **reason-aware**: a `run_in_flight` conflict with a known `runId` is auto-resumed under `--wait` (the CLI polls the in-flight run to its verdict instead of exiting 6), and other causes — a view-only mirror project, an un-runnable/local environment, an unknown id, a billing refusal (`insufficient_credits` / `billing_hold`, carrying the server's message), a dispatch error — are named individually rather than reported as a blanket "already in flight". A batch where **nothing** dispatched, nothing was rate-deferred, and every conflict is `insufficient_credits` exits `12` (`INSUFFICIENT_CREDITS`, with the billing `nextAction`) — the same shape a single `test run` answers — instead of a generic conflict `6`; a newer backend answers that case with the 402 envelope directly and the CLI maps it identically. A batch refused **entirely** for a billing hold is answered by the current backend with the standard `403` `FEATURE_GATED` envelope (`details.reason: 'billing_hold'`, plus the hold `state`) — surfaced as `FEATURE_GATED`, exit `13`, with the server's `nextAction`, exactly like a single `test run`; only a mixed batch (some cases dispatched) carries per-case `billing_hold` conflicts, and an older backend that folds every case into such conflicts still exits `6` with the hold named in the message. Rate-deferred tests are retried on a time budget: retries continue until `--timeout` minus a reserved final poll window (60 s, or a third of the timeout for short timeouts), rather than a fixed attempt count.

#### Local frontend testing and tunnels

A tunnel connects the cloud frontend agent to an app running on **this machine**. It supports the **Free plan**; ordinary run credits still apply: a V3 frontend `--local` run costs **0.5 credit**, like any frontend run. The API key needs `run:tunnel` in addition to the scopes for running tests. The CLI identifies a missing scope; a key deliberately narrowed without it needs a key that includes it.

**Transport security and bounded retry.** The control plane is WebSocket over TLS at `wss://control.tun.testsprite.com/ws`. The data plane carries both the tunnel secret and proxied traffic over TLS at `data.tun.testsprite.com:443`, with the certificate verified by Node's default trust store: its bundled Mozilla roots, plus certificates supplied through `NODE_EXTRA_CA_CERTS` and the system CAs when Node is started with `--use-system-ca`. Node 20 retains `NODE_EXTRA_CA_CERTS` when explicit roots are also configured. Certificate verification cannot be disabled, and the CLI never falls back from TLS to plaintext. On a network that re-signs TLS, export your organisation's root CA to a PEM file and set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` before running `testsprite`. Plaintext connects and TLS handshakes each have a 10-second timeout. The first failed attempt opens a **60-second** retry episode. A successful `TunnelHello` write does not establish the session: only the first inbound tunnel stream or a socket that remains open for 5 seconds after the hello ends the episode. The deadline remains armed across backoff and later attempts, destroys any in-flight socket when it expires, reports one terminal data-plane error, and stops the client. An owned `test run --local` run is then cancelled and refunded and the command exits **10**; `tunnel start` exits **10**. Intentional shutdown reports no data-plane error. When a self-hosted or older TestSprite server does not advertise a TLS endpoint, the CLI instead prints a one-time warning and uses the legacy plaintext data port **7400** under the same retry rules. `tunnel start` makes the selected mode visible as `transport: tls` or `transport: plaintext`.

```bash
# A saved loopback environment opens a tunnel and waits automatically
testsprite test run <test-id> --env local-dev --output json
# Or supply an ad-hoc loopback target
testsprite test run <test-id> --target-url http://localhost:3000 --output json
# Several frontend tests share one tunnel and run five at a time by default
testsprite test run <id> <id> --local 3000 --max-concurrency 5 --output json
testsprite test run --all --project <project-id> --local 3000 --output json
# A different loopback listener, or a longer run
testsprite test run <test-id> --env local-dev --timeout 1800
```

| Flag                          | Local-run behavior                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--local <port>`              | Frontend only; port 1–65535. Opens one tunnel for the invocation and implies `--wait`. Mutually exclusive with `--target-url` (exit 5).                                                                                                                                                                                                                                                                 |
| `--max-concurrency <n>`       | With tunnel batches, at most 1–10 runs in flight; default **5**. The timeout applies to each run from its own trigger.                                                                                                                                                                                                                                                                                  |
| `--local-host <host>`         | With `--local` only; `localhost`, `127.0.0.1`, or `::1`. Deprecated on project/environment writes. The shorthand defaults to the selected loopback environment's host, else the one host agreed by saved non-temporary loopback environments on that port, else `localhost`; unreadable lists retain `127.0.0.1`. Chooses the loopback name in the run's target URL; LAN/RFC1918 addresses are refused. |
| `--tunnel-client <client-id>` | Borrows the non-secret client id from `tunnel start` for a loopback target or selected environment. Still implies waiting, but ownership stays with the separate tunnel process.                                                                                                                                                                                                                        |
| `--timeout <seconds>`         | 1–3600; default **600** for ordinary waits, **1200** for tunnel runs, including adopted tunnels.                                                                                                                                                                                                                                                                                                        |
| `--no-cancel-on-interrupt`    | For tunnel runs; opts out of automatic cancellation when an owned tunnel closes or a borrowed tunnel's owner disappears. The run can no longer reach the app and remains billable.                                                                                                                                                                                                                      |
| `--skip-preflight`            | Skips the local port probe. Normally a dead port is refused before minting a tunnel or charging a run (exit 5). It does not bypass flag, scope, or backend preconditions.                                                                                                                                                                                                                               |

**Concurrency.** Run several frontend tests with `test run <id> <id> … --local <port>` or all frontend tests in a project with `test run --all --project <id> --local <port>`. One invocation mints one binding and runs up to **5** tests concurrently by default (`--max-concurrency` accepts 1–10); `--all` reports backend tests as skipped. A user can have **5 live tunnel bindings**. The `tunnel_binding_limit` reason is exit 11 and is **not auto-retried**: stop an unused tunnel or reuse an existing one with `--tunnel-client` before retrying. Ctrl-C stops queuing, cancels unfinished runs on an owned tunnel by default, and prints one partial JSON object with `not-run` rows; tunnel loss also stops queuing and exits 10. The minted client id is printed before connecting so a failed connection still identifies the binding.

**Login and execution.** Tunnels serve frontend tests. An explicit loopback target on a backend test fails client validation (exit 5); single backend tests keep their previous cloud path; tunnel batches skip only backend tests whose own selected environment is loopback, and include their IDs in `skipped`. Public-environment backend tests dispatch normally. The project environment's username/password are passed to the cloud agent, which logs in inline through the tunnel. OTP environments are refused **before charge** with exit 6 (`tunnel-otp-auth-unsupported`). V3 `--local` runs always use the agent path, never saved-code replay, and **do not overwrite the test's saved code**. Saved loopback environments also open tunnels for reruns. Rerun and test-list tunnel batches use one `--timeout` deadline, including capacity waits. Explicit public-environment sign-in against a local origin is announced once on stderr. Rerun/test-list responses must echo the tunnel client id; if an old server strips it, the CLI attempts to cancel what started and exits with a clear error.

**Timeout, cancellation, and refunds.** When a single owned `--local` run stops waiting before a terminal result, the CLI cancels it by default and closes its tunnel. This includes `--timeout` (exit 7), Ctrl-C (exit 130), and non-terminal polling/tunnel failures. In a local batch, each test has its own timeout measured from its trigger: a timed-out run is cancelled on an owned tunnel, the other tests continue, and the tunnel closes after the batch settles. Cancellation can race completion or fail; read the reported outcome instead of assuming it succeeded. **A run cancelled before it finished is refunded.** Cancelling an already-finished run does not replace its result or refund it. After an owned local timeout, start a **new** run with `testsprite test run <test-id> --env <name> --timeout 1800`; `test wait` cannot restore the closed tunnel. `--no-cancel-on-interrupt` detaches instead, but does not keep an owned tunnel alive.

A borrowed `--tunnel-client` run is not cancelled on Ctrl-C/SIGTERM: the borrower detaches, never closes or deletes the adopted tunnel, and `test wait <run-id>` can resume polling while the owner keeps it alive. If liveness reports that the owner is gone while the run is non-terminal, the borrower cancels **its own run** exactly as an owned doomed run does. The message names the run id and the observed result (`cancelled`, `already finished`, or `skipped`), then points to the run read before a retry. A run cancelled before it finished is refunded. `--no-cancel-on-interrupt` skips the owner-gone cancel too, leaving the run executing and billable without a working tunnel.

**Retargeting a local case.** Cloud runs such as Portal Run and schedules cannot reach a loopback environment and are **free BLOCKED** with reason `tunnel-required`. A CLI frontend run opens a tunnel when the resolved saved environment is loopback. Select that environment with `--env <name>`, or explicitly retarget the case using `test run <test-id> --target-url https://staging.example.com`. For a project created with `project create --local`, also set its public project URL with `project update <id> --url https://…` to enable Portal runs.

#### `testsprite tunnel start` / `list` / `status` / `stop`

Keep a tunnel alive across runs by running its owner in a separate terminal:

```bash
# Terminal A — no positional port; keep this process running
testsprite tunnel start --ttl 3600
# Terminal B — use the clientId printed by terminal A
testsprite test run <test-id> --env local-dev --tunnel-client <client-uuid>
testsprite tunnel list
testsprite tunnel status <client-uuid>
testsprite tunnel stop <client-uuid>
testsprite tunnel stop --all --confirm
```

`tunnel start` runs in the foreground; there is no daemon. It prints the client id and expiry to stderr immediately after minting, before attempting to connect, then prints the selected `transport: tls|plaintext` alongside the client id, expiry, and online status. The secret stays in memory. `--ttl <seconds>` requests a credential lifetime of **60–28800 seconds** (the server clamps the value; the CLI requires a positive whole number). The credential is deleted when the owner exits, regardless of TTL. Ctrl-C on `tunnel start` is a normal stop (exit 0); service disconnection or observed credential revocation is exit 10 (`UNAVAILABLE`). A selected data-plane transport that never becomes established is retried for up to 60 seconds before the same exit 10.

`tunnel list` shows every live binding for this account, with its client id, connection status, creation time and expiry; `unknown` means TestSprite could not check the connection at that moment. JSON returns `{ tunnels: [...] }`. An empty list succeeds. Listing needs `run:tunnel` (auth exit 3); an older server without the route returns exit 4 with guidance to stop a known id or wait for expiry.

`tunnel status <uuid>` and `tunnel stop <uuid>` require a UUID; a non-UUID is rejected locally with exit 5, including under `--dry-run`. Status returns exit 0 even for an explicit `offline` response; an absent binding is exit 4, and an API/transport failure is reported as an error rather than relabelled offline.

Stop is idempotent and prints **`Tunnel credential <uuid> revoked (or already absent).`**; JSON stays `{ clientId, deleted: true }`. A running `tunnel start` exits **10** immediately on the server's revocation close, with its approximately **15-second** status cadence as a backstop. Stop itself does not issue run cancellation; an attached borrower that observes the owner gone cancels its own non-terminal run unless `--no-cancel-on-interrupt` was passed.

Hit the tunnel limit? List your bindings with `testsprite tunnel list`, then stop an unused one with `testsprite tunnel stop <client-uuid>`. `testsprite tunnel stop --all --confirm` revokes every live binding on the account, including bindings owned by another terminal or CI job. It deletes sequentially, reports each result, and exits 1 if any stop fails. `testsprite --dry-run tunnel stop --all` uses sample ids and makes no real deletion; run `tunnel list` to see the actual bindings before confirming.

A second `tunnel start` or process using the same credential takes over, and the first exits **10**. Dev servers can take a minute per page through the tunnel; for a heavy dev server, test a built server with `npm run build`, then the framework's preview/start command.

| Exit | Meaning and next step                                                                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `3`  | Authentication/scope error; if `run:tunnel` is missing, mint a new API key.                                                                                                         |
| `5`  | Validation: dead local port, invalid port/host/UUID, incompatible flags, or no runnable frontend tests in a local batch (unless `--allow-empty`).                                   |
| `6`  | Precondition, including `tunnel-required`, `tunnel-offline`, or `tunnel-otp-auth-unsupported`; resolve the named condition before retrying.                                         |
| `7`  | Wait timeout or unsupported operation, including `tunnel-unsupported-for-backend-test` and `local-origin-requires-v3`. An owned local timeout requires a new run, not reattachment. |
| `10` | Unavailable: transport/service failure, tunnel lost, or the owner observed revocation/expiry.                                                                                       |
| `11` | Rate limited, including `tunnel_binding_limit`; the binding-cap reason is not auto-retried.                                                                                         |

#### `testsprite test rerun [test-id...]`

Re-execute one or more tests as a **replay** — distinct from `test run`, which starts a fresh run. A frontend rerun uses the saved script (verbatim unless AI heal-on-drift engages); a backend rerun re-runs the named test together with its producer/teardown dependency closure. Frontend reruns request auto-heal by default; the server controls the default for fresh test runs. A rerun needs a saved run, and a backend rerun expands the dependency closure. A rerun is billed the same as a fresh run — 0.5 credits per FE rerun, 0.2 credits per BE rerun (legacy V2 accounts: FE rerun remains free). Without `--wait`, prints the queued run(s) and exits 0; with `--wait`, polls to terminal with the same exit-code matrix as `test run --wait`.

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

# Replay against a named environment (its credentials / auto-auth); see `project env`
testsprite test rerun test_xxxxxxxx --env staging --wait --output json
```

Batch `--report` flags apply only to batch `--wait` reruns (`--all` or multiple test ids). `--report junit --report-file <path>` writes a JUnit XML sidecar after polling completes (atomic write); `--output json` is unchanged. When `--project` is omitted, the CLI infers `projectId` from polled run rows for classname / default suite naming; if inference fails, pass `--project <id>` explicitly (required under `--dry-run`).

Flags:

- `--all` — rerun every test in the resolved project; requires `--project <id>`.
- `--wait`, `--timeout <s>` — block until terminal; same exit matrix as `test run --wait`.
- `--no-auto-heal` — ask for a verbatim replay instead of frontend AI heal-on-drift, which is on by default for frontend reruns. When healing engages, the agent re-authors the test and the new code replaces the stored version — a rerun asks for healing explicitly, so this includes code you wrote yourself; pass `--no-auto-heal` to replay it verbatim. Ignored for backend reruns. What a heal costs depends on which execution engine answers — on the current engine it is a full agent run, billed as the run with nothing extra; on legacy V2 accounts a verbatim-replay pass is free and only a heal engage costs credit. `testsprite usage` reports the figure that applies to your account. Unlike `test run --no-auto-heal`, a rerun gets no echo of the server's effective decision, so a dropped opt-out cannot be detected here — there is no advisory on this path.
- `--skip-dependencies` — backend only: rerun just the named test without expanding the producer/teardown closure.
- `--max-concurrency <n>` — with `--wait`, cap on in-flight polls during a batch rerun.
- `--idempotency-key <key>` — auto-minted when omitted (the minted key is printed to stderr under `--output json`, `--verbose`, or `--debug`).
- `--report junit --report-file <path>` — with batch `--wait`, write a JUnit XML sidecar after polling (atomic write). Optional `--report-suite-name <name>` overrides the default `testsprite:<projectId>` suite name. Requires `--wait`; not available on single-test reruns.
- `--gh-output` / `--summary-file <path>` — with batch `--wait`: GitHub-native CI output, same behavior as on `test run` (see above) — `::error::` annotations for failed/timed-out runs, `::warning::` annotations for never-dispatched tests, a job-summary table under GitHub Actions, and the reduced machine summary JSON. Not available on single-test reruns.
- `--allow-empty` — with `--all`: exit 0 when the resolved rerun set is empty (no tests match `--filter`/`--status`/`--skip-terminal`, or the project has none). Default is to fail with exit 5, since a rerun step that greens on zero dispatched runs is an unsafe CI gate.

A batch rerun returns `accepted[]` (one `runId` per dispatched test) plus `deferred[]` for any test shed by the per-key run-rate limit; under `--wait`, a non-empty `deferred[]` exits 7 with a `nextAction` you can retry with a fresh idempotency key. A batch where **every** requested id lands in `notFound` (no replayable run) exits **4** — nothing was queued, so the run must not pass; a mixed batch surfaces its `notFound` ids as `skipped` rows in the CI summary without failing an otherwise-passing batch.

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

Block until one **or more** runs reach a terminal status. With a single `run-id` the behavior is unchanged: same exit-code matrix as `test run --wait`. With several ids, the runs are polled concurrently under one shared `--timeout` and the CLI prints a `{ results, summary }` envelope — the worst status wins the exit code — so every re-attach hint the CLI prints can be pasted back as one command. `--max-concurrency <n>` (1–100, default 10) caps concurrent polls. Used to resume polling after an ordinary timed-out `--wait`, or after detaching from an adopted tunnel whose owner is still running. For an owned tunnel timeout, start a new `test run <test-id> --env <name> --timeout 1800`; polling cannot restore its closed tunnel.

```bash
testsprite test wait run_01hx3z9p8q4k2y7a --timeout 600 --output json
testsprite test wait run_aaaa run_bbbb run_cccc --timeout 900 --output json
testsprite test wait run_01hx3z9p8q4k2y7a --dry-run --output json
```

With several ids, a per-member poll error (e.g. one id not found) is recorded as `error:<CODE>` in that run's row and folded into exit 7, rather than aborting the whole batch. Polling is handled automatically — the CLI uses server-driven long-poll where supported and exponential backoff with jitter otherwise, honoring `Retry-After`.

A `RATE_LIMITED` (429) poll is the one per-member error that is retried before it becomes an outcome: each member re-polls up to 3 times, sleeping the server's `Retry-After` (except a standing limit such as `tunnel_binding_limit`, which is not auto-retried). Each backoff is clamped to the shared `--timeout` deadline, and a backoff interrupted by Ctrl-C detaches normally; if the deadline is reached during one, that member reports a **timeout** (exit 7), not a rate limit.

If the throttle outlasts the retry budget **and** nothing else went wrong — no timeouts, no failed runs, no other error codes, and no repeated run id in the argument list — the exit code is **11** (rate limited) rather than 7, because the correct next action is to back off before re-attaching, not to retry immediately. Any timeout or non-passed run in the same invocation keeps the usual 7 / 1.

One caveat this does not fix: the HTTP layer's own 429 retries (up to 3, honoring `Retry-After`) are bounded by their own budget, not by `--timeout`, so a sustained throttle can still overshoot the deadline by roughly one retry chain before the command gives up. That is pre-existing behavior on every polling command, not something this retry loop introduced — the outer loop re-checks the deadline before each of its own attempts.

#### `testsprite test cancel <run-id...>`

Cancel one or more in-flight runs — the counterpart to Ctrl-C, which only **detaches** (the server-side run keeps executing and billing) for an ordinary run. An owned `--local` run is the exception: Ctrl-C already cancels it by default (its tunnel closes with the process, so there is nothing left to detach from — see `--no-cancel-on-interrupt` to opt out). A borrowed run also cancels itself if it observes that its tunnel owner disappeared, but an ordinary borrower Ctrl-C remains a detach. A run cancelled before it finished is refunded. Cancelling is idempotent: an already-cancelled run reports `alreadyCancelled` as an advisory, not an error; a run that already reached a terminal verdict is a conflict — the verdict is never overwritten, and no credits are refunded. With one id, prints the run card; with several, prints a `{ cancelled, alreadyCancelled, conflicts, notFound }` summary. Exit codes: any unknown id → 4; else any conflict → 6; else 0.

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

**`testlist run`** dispatches each case through its project's configured environment and returns a pollable `runId` per case (the same id `test wait` / `runs` accept). Without `--wait` it exits 0 once every case is accepted (a fire-and-return, like `test run` without `--wait`). With `--wait` it polls every run to terminal and the exit code reflects the batch: **0** all passed, **1** any failed, **4** a partial `--case` miss — some requested ids are not members of the list (checked after the poll, so a genuine failure or timeout on the matched subset is reported first; the missed ids are warned to stderr at dispatch and carried on `notFound` in the JSON), **6** nothing new was dispatched because every targeted case conflicted — causes are named individually (already in flight, view-only mirror project, un-runnable environment, unknown id, dispatch error), and this exits 6 on the non-`--wait` path too, **7** any run timed out (against `--timeout`, default 600 s) or was rate-deferred (also on the non-`--wait` path — a partial dispatch never passes CI silently). A per-member poll error surfaces its real exit code through the shared `--wait` precedence table (see `test run`). `--case <test-id>` (repeatable) runs a subset; an empty match (no accepted, no conflicts) returns a `reason` and exits 0. `--report junit --report-file <path>` writes a JUnit sidecar after polling (suite name defaults to `testsprite:testlist:<listId>`; override with `--report-suite-name`; unlike `test run --all` / `test rerun` reports, `<testcase>` rows currently carry the test id as the name and no duration). Under `GITHUB_ACTIONS=true` (or `--gh-output` to force it locally) a `--wait` run also emits annotations (`::error::` for failed/timed-out members, `::warning::` for never-dispatched ones) + a job-summary table, and `--summary-file <path>` writes the reduced machine summary JSON (`{total, passed, failed, skipped, timedOut, runs[]}`); both require `--wait`, and non-dispatched members (conflicted, not-found) fold into the summary as `skipped` rows — visible, but never counted as `failed` — so a partial run cannot read as all-passed and the artifact cannot contradict the exit code.

Every mutation (`create`/`update`/`delete`/`add`/`remove`) is refused with a billing-hold envelope on a **paused** team workspace (matching the portal's read-only wall); `delete` also removes the list's schedules and their triggers, so it requires `--confirm`. All commands accept the global `--output json|text` and `--dry-run` (offline shape-accurate sample).

### Schedules (`schedule`)

A **schedule** runs a project or a test list on a cron, unattended — the CLI surface for the portal's Monitoring view. Every firing is a full test run, billed like any other, so the CLI states how often a cron works out to **before** it sends the request. Schedules are **entitlement-gated**: a plan that does not include them gets `FEATURE_GATED` (exit 13), and an account or backend that does not serve schedules at all gets `UNSUPPORTED` (exit 7).

```bash
# Read
testsprite schedule list                       # table: ID / NAME / STATUS / TARGET / ENVIRONMENT / CRON / TZ / LAST RUN
testsprite schedule list --columns id,name,cron --no-header   # pick + reorder columns for scripts
testsprite schedule get <schedule-id>          # one schedule, one field per line
testsprite schedule run list <schedule-id>     # past runs: RUN ID / STATUS / TOTAL / PASS / FAIL / BLOCK / STARTED

# Create (each mutation sends an auto-minted Idempotency-Key; pass --idempotency-key to control it)
testsprite schedule create --name "Nightly checkout" \
  --target-type testList --target-id tl_aaaa \
  --cron "0 3 * * *" --timezone America/New_York \
  --send-to oncall@example.com,qa@example.com
testsprite schedule create --name "Staging nightly" \
  --target-type project --target-id proj_aaaa --env staging --cron "0 3 * * *"

# Update, pause, resume
testsprite schedule update <schedule-id> --name "Renamed"
testsprite schedule update <project-schedule-id> --env staging
testsprite schedule update <schedule-id> --cron "0 6 * * 1"   # re-states the new frequency first
testsprite schedule update <schedule-id> --pause              # stop it firing, keep the schedule
testsprite schedule update <schedule-id> --resume

# Delete — removes the schedule AND its run history, and stops future triggers
testsprite schedule delete <schedule-id> --confirm
```

**Target.** `--target-type project` runs the project's **entire live suite** on every tick — there is no way to schedule a subset of a project's tests, so use a test list for that. `--target-type testList` runs the list's cases, each through its project's configured environment (see [Test lists](#test-lists-testlist)). `--target-id` is the matching project id or test-list id, and a target that does not resolve is a `404` (exit 4). Deleting a test list also deletes its schedules.

**Environment.** On a project target, `--env <name>` pins the schedule to that environment name. Without it, a new schedule uses the project's live default at each tick; changing the default changes future ticks. An unknown or deleted name fails validation rather than falling back. `schedule update --env` pins an existing project schedule; omitting it leaves its current mode unchanged. There is no unpin flag. Test-list schedules inherit the list's live per-project bindings: change those with `testsprite testlist update <testlist-id> --project-env <projectId>:<environmentName>`. `schedule create --target-type testList --env` fails locally (exit 5); `schedule update --env` sends the request and the API rejects it if that schedule targets a test list. Blank `--env` values fail locally (exit 5).

Text output derives `staging (pinned)`, `project default (inherits)` or `-` from the API response. The list's `ENVIRONMENT` column is appended after all existing columns; get/update append the environment detail line. JSON preserves exact `environment` and `environmentMode` fields, including `null` or omission. For explicit `--env`, the CLI first reads existing schedules: a project schedule with no environment mode proves the server is too old and returns `UNSUPPORTED` (exit 7) before a write. An empty or unreadable list is inconclusive, so response confirmation still applies. An unconfirmed create is best-effort deleted, reporting the exact created id and whether it was removed; an unconfirmed update reports the schedule id and other requested fields that may have been applied. Commands without `--env` add no capability read and retain their previous output when the server omits environment fields.

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

### CI integration (`ci init`)

`ci init github` writes a ready-to-run GitHub Actions workflow to `.github/workflows/testsprite.yml` so you don't hand-copy one. The generated workflow delegates to the published [`TestSprite/testsprite-action@v1`](https://github.com/TestSprite/testsprite-action) — the action installs the CLI, runs the tests, emits `::error::` annotations + a job-summary table, uploads a JUnit report, and (by default) **fails the job when tests are skipped** rather than reporting a partial run green. The scaffold stays thin because that logic lives in one maintained place.

```bash
# Scaffold — auto-detects your project if the key has exactly one
testsprite ci init github
testsprite ci init github --project proj_xxxxxxxx      # pin a specific project
testsprite ci init github --filter checkout            # only tests whose name matches
testsprite ci init github --dry-run                    # preview the file, write nothing
testsprite ci init github --force                      # overwrite an existing workflow (keeps a .bak)

# Optionally set the repo secret in the same step (needs gh installed + authenticated)
testsprite ci init github --set-secret --repo owner/name
```

The generated workflow pins the CLI version (not `latest`), sets `permissions: contents: read`, skips pull requests from forks (which run without repository secrets, so the check would be permanently red), and triggers `push` only on the repo's default branch. The API key comes from a `TESTSPRITE_API_KEY` repo secret; `ci init` prints the exact `gh secret set TESTSPRITE_API_KEY` command to add it, and `--set-secret` runs it for you when the [`gh` CLI](https://cli.github.com) is installed and authenticated (the key is passed on stdin, never the process list), degrading to the printed instruction otherwise — it never fails the scaffold. `--project` is optional only when the key owns exactly one project; with zero or several, pass it explicitly (a validation error names the fix). The endpoint is resolved from your profile (or `--endpoint-url`), so a workflow scaffolded against a non-prod backend targets that backend; if that endpoint is a loopback/private address a GitHub-hosted runner can't reach, `ci init` warns (it still writes the file — self-hosted runners are legitimate). By default `ci init` refuses to overwrite an existing workflow; `--force` keeps a `.bak` of the old one first. Every run accepts the global `--output json|text` and `--dry-run`.

> The generated gate uses the project's configured environment by default. To test a PR preview, pass its URL to `test run --all --target-url <url>` in the workflow. The gate does not check out or build the PR's code; pair it with your usual build/test checks.

#### `testsprite ci doctor` / `testsprite ci connect`

A workflow triggered by deployments (`on: deployment_status`) only fires if the repo actually **receives** GitHub Deployment events. Those records are written by whatever deploys your app — Vercel's own GitHub App writes them when the project is git-linked to the repo — and GitHub broadcasts the event to every subscriber. When the platform isn't linked, nothing is written, so nothing ever fires: no error, no annotation, no check. The gate is simply silent, which is far harder to notice than a red one.

`ci doctor` turns that invisible state into a verdict by reading the repo's deployment history through `gh` (the same soft dependency `--set-secret` already uses, so it carries your own GitHub credentials — needed for a private repo):

```bash
testsprite ci doctor                      # infers the repo from the `origin` remote
testsprite ci doctor --repo owner/name    # or name it explicitly
testsprite ci doctor --wait               # keep checking until a NEW deployment record lands
```

| Verdict           | Meaning                                                                                                                                                                                            | Exit |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `linked`          | Recent **preview** deployment events reach this repo — a gate will fire.                                                                                                                           | 0    |
| `none`            | No events at all. Either the platform isn't linked, **or** it is linked and hasn't deployed yet — the two are indistinguishable from GitHub's side, so the output names both rather than guessing. | 1    |
| `production-only` | Events exist, but none for a preview environment. A PR gate keys on preview deployments, so it would never run on a pull request — enable preview deployments on your platform.                    | 1    |
| `stale`           | The newest **preview** event is months old; the link may have been removed since. Production deploys don't freshen this — a repo shipping daily can still have a dead preview link.                | 1    |

A failure to _read_ the history (no `gh` on PATH, not authenticated) exits **10**, deliberately distinct from the verdicts above: "I couldn't check" must not be reported as "not linked", or you'd go fix the wrong thing.

`--wait` is the post-connect check: it baselines the history on its first read and succeeds (exit 0) as soon as a **new** deployment record arrives — whatever its environment, because a new record is the hard fact that events reach this repo. (A push to the default branch deploys as _production_; that still proves the link is live, and the printed verdict tells you whether a PR gate additionally needs previews.) A transient `gh` failure mid-watch is retried rather than aborting; exit 10 is reserved for a wait that never managed a single successful read.

`ci connect` is the fix for `none`. It runs the platform's **own** CLI as a subprocess (`npx vercel link` → `vercel git connect`, pinned to `vercel@59`), so nothing needs pre-installing and **your Vercel credentials stay with the Vercel CLI** — this command never asks for, stores, or transmits a platform token. Every step is non-interactive, and it never passes `--yes` to the Vercel CLI: on an unlinked directory `vercel link --yes` would _create_ a project named after the current directory and wire the repo to it — a stray project `ci doctor` would then happily report as `linked`. Instead:

- Directory already linked (`.vercel/project.json` exists) → straight to `vercel git connect`.
- Not linked → requires `--project <name>` (an **existing** Vercel project) and runs `vercel link --project <name>`.
- Not linked and no `--project` → refuses, and tells you to either pass the flag or run `npx vercel link` yourself to pick interactively.

What it cannot do, it says plainly: installing the Vercel GitHub App is a browser OAuth, and an organization that restricts third-party apps needs an admin — in both cases it relays the platform CLI's own message (including the structured `reason` / next-step output Vercel's non-interactive mode emits), rather than paraphrasing the fix away. Heads-up: `vercel link` itself writes `.vercel/`, may add a `VERCEL_OIDC_TOKEN` line to `.env.local`, and may update `.gitignore` — the Vercel CLI's own behavior.

Linking only affects **future** pushes, so the loop closes with a push and a re-check — on a branch, so the deployment lands as a preview (the kind a PR gate keys on):

```bash
testsprite ci connect
git checkout -b verify-testsprite-ci
git commit --allow-empty -m "verify testsprite ci" && git push -u origin HEAD
testsprite ci doctor --wait
```

**Self-hosted pipeline?** You don't need any of this — report each deploy to GitHub yourself and every trigger path works identically, because they all consume the same event:

```bash
ID=$(printf '{"ref":"%s","environment":"preview","auto_merge":false,"required_contexts":[]}' "$SHA" \
  | gh api repos/OWNER/REPO/deployments --input - --jq .id)
gh api repos/OWNER/REPO/deployments/$ID/statuses -f state=success -f environment_url=$PREVIEW_URL
```

`required_contexts: []` is not optional in practice: without it GitHub refuses to create the deployment with a `409 Conflict` whenever any commit status on that SHA is failing — which, on a PR whose checks are still red, is exactly when your pipeline is deploying a preview. The JSON-input form is used because `gh api -f` sends everything as a string, and an empty array has to stay an array.

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

| Flag                          | Purpose                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `--profile <name>`            | Pick a named profile (default: `default`)                                                          |
| `--endpoint-url <url>`        | Override the API host                                                                              |
| `--output json\|text`         | JSON is the stable automation contract; text is human-friendly                                     |
| `--request-timeout <seconds>` | Per-request wall-clock timeout (default 120, range 1–600)                                          |
| `--verbose`                   | Human-readable HTTP retry / backoff / polling messages to stderr                                   |
| `--debug`                     | Method / URL / request-id / latency / retry decisions to stderr (the API key is never included)    |
| `--dry-run`                   | Preview without writes or charges; configured `test run` may read metadata for its tunnel decision |

### Secrets in output

Any field named like `password`, `token`, `secret`, `apiKey` / `api_key`, `authorization`, `cookie`, or `credential(s)` — at any depth, inside arrays too — is replaced with `[REDACTED]` in an error envelope's `details` and in `--debug` request tracing, in both `--output json` and text. `--dry-run` previews never contain a secret in the first place: they show presence flags (such as `hasCredentials`) and field names, not credential values. This is a second, independent layer: the backend already redacts its own error envelopes, but the CLI redacts again on the way out. Ordinary fields that merely contain one of those words as a substring — a boolean presence flag like `hasCredentials`, a file path like `credentialsPath`, or a pagination cursor like `nextToken` — are left alone; only the credential-shaped field itself is blanked.

**Success output is never redacted.** A command's result — generated test code, plans, backend-test fixtures — is the caller's own data and must round-trip byte-identical (`test code get --output json` piped through an edit into `test code put`, `test plan get` into `test plan put`): it prints exactly as the server stored it, even when it legitimately contains a literal `Authorization: Bearer …` header or a `password` key. Redaction only ever touches error envelopes and request traces, never a success payload.

`project env create/update` also reject conflicting credential flags before a `--dry-run` plan. For backward compatibility, `project create/update` keep `--password` precedence when `--password-file` is also given, with a one-line stderr warning; the ignored file is never read.

### Environment variables

| Variable                                   | Purpose                                                                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TESTSPRITE_API_KEY`                       | API key - overrides the credentials file                                                                                                                                      |
| `TESTSPRITE_API_URL`                       | API endpoint - overrides the credentials file                                                                                                                                 |
| `TESTSPRITE_PROFILE`                       | Active profile (below `--profile`, above `default`)                                                                                                                           |
| `TESTSPRITE_PROJECT_ID`                    | Default project for `test list`, `test create`, and `test run --all` when `--project` is omitted                                                                              |
| `TESTSPRITE_REQUEST_TIMEOUT_MS`            | Per-request timeout in **milliseconds** (default `120000`, range `1000`-`600000`)                                                                                             |
| `TESTSPRITE_NO_UPDATE_NOTIFIER`            | Any non-empty value disables the once-per-24h "new version available" notice                                                                                                  |
| `NO_COLOR`                                 | Suppress ANSI escape sequences in ticker output ([no-color.org](https://no-color.org/))                                                                                       |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`  | Standard proxy support - API traffic is routed through the configured proxy                                                                                                   |
| `TESTSPRITE_NO_SKILL_WARNING`              | Any non-empty value silences the "verify skill not installed" reminder (CI / manual use)                                                                                      |
| `TESTSPRITE_NO_TELEMETRY` / `DO_NOT_TRACK` | Any truthy value (not `0`/`false`/empty) disables usage telemetry (see Telemetry below)                                                                                       |
| `TESTSPRITE_PORTAL_URL`                    | Override the Portal origin used for `dashboardUrl` links (non-prod environments)                                                                                              |
| `TESTSPRITE_CLIENT`                        | Identifies a wrapper driving the CLI (`<name>/<version>`, e.g. `github-action/v1`); appended to the User-Agent and reported as telemetry `client`. Invalid values are ignored |

### Telemetry

Authenticated runs send one best-effort "command outcome" event per invocation
to TestSprite (`POST /api/cli/v1/telemetry`) so we can measure which commands
run and diagnose failures. Each event carries only:

- the command name (e.g. `test run`), the outcome (`success`/`error`/`abort`),
  the exit code, a machine error **code** (e.g. `VALIDATION_ERROR`), and the
  duration;
- context: CLI version, OS, Node version, output mode, CI-vs-interactive (`ci`),
  and — when present — the wrapper identity from `TESTSPRITE_CLIENT` (`client`);
- CI context: `ciProvider` (`github` / `gitlab` / `circleci` / `buildkite` /
  `other` / `none`, from the vendor's standard env markers), and under GitHub
  Actions `ciEvent` (`push` / `pull_request` / `schedule` / `workflow_dispatch` /
  `other`) and `repoHash` — the first 16 hex chars of a salted SHA-256 of
  `GITHUB_REPOSITORY`, so runs from one repository can be grouped without the
  repository name ever being sent;
- for `test run --all`, `testlist run` and `test run <id> --wait`: outcome
  **counts** only — `accepted`, `conflicts`, `deferred`, `skipped`, and the
  verdicts `passed` / `failed` / `blocked` / `timedOut` (disjoint; `failed`
  excludes blocked runs) — plus `conflictReason`, the most frequent reason a
  case did not dispatch (`in_flight`, `insufficient_credits`, `billing_hold`,
  `mcp_view_only`, `local_address`, `tunnel-required`, `error`);
- `local=true` for an explicit `--local` invocation (including borrowed/refused runs and project creation) or an automatically opened tunnel; tunnel runs also record `localConcurrencyLimit` and `localPeakInFlight`, the chosen limit and maximum number of active tunnel runs;
- for `ci init`: `platform`, whether `--force` was passed, whether a workflow
  file already existed at the target path (`workflowExisted`), and whether the
  project came from `--project` or auto-detection (`projectResolved`).

It **never** sends: your API key, target URLs, free-form flag or argument values, test or
run ids, repository names, or error **messages**. The event is a fixed
allowlist; timeout seconds and the local concurrency limit are bounded numeric controls. It is bounded to ~1s and fully best-effort — it never delays beyond that,
never changes a command's behavior or exit code, and is skipped entirely when no
API key is configured or under `--dry-run`.

Opt out with `TESTSPRITE_NO_TELEMETRY=1` or the cross-tool
`DO_NOT_TRACK=1` (any truthy value; `0`/`false`/empty do not opt out).

### Update notice

Interactive runs print a one-line "new version available" notice on stderr when
a newer release exists. To learn this, the CLI contacts the public npm registry
(`registry.npmjs.org`) at most once per 24 hours; the request carries the
package name only - never your API key, project data, or command line. The
check is skipped in CI, when stderr is not a TTY, under `--output json` /
`--dry-run`, and entirely when `TESTSPRITE_NO_UPDATE_NOTIFIER` is set. Any
failure is silent: the notice can never break or delay a command. Target reachability probes and local tunnels also connect to their respective endpoints.

Separately, the backend advertises its **minimum supported CLI version** on
every `/api/cli/v1` response. When the running CLI is below that floor, a
one-line upgrade advisory is printed to stderr (same opt-outs as the update
notice; it never changes the exit status). Under GitHub Actions
(`GITHUB_ACTIONS=true`) the same observation is surfaced once per job as a
`::warning title=TestSprite::` annotation instead — a `ci init`-generated
workflow pins `cli-version`, so the job keeps running that version until the
workflow is regenerated (`testsprite ci init github --force`); the annotation
fires only when the pinned version has fallen below the backend floor, never
merely behind the newest npm release (the registry check is skipped in CI). A
backend may also reject a too-old client outright with HTTP 426 - surfaced as
`CLIENT_TOO_OLD`, exit `14`, non-retriable, with upgrade guidance.

### Scopes

API-key scopes gate the write and run surfaces:

| Scope            | Required by                                                             |
| ---------------- | ----------------------------------------------------------------------- |
| `read:me`        | `auth status`, `usage`, `doctor` (connectivity check)                   |
| `read:projects`  | `project list / get`                                                    |
| `read:tests`     | every `test *` read command                                             |
| `write:tests`    | `test create / create-batch / update / delete / code put / plan put`    |
| `write:projects` | `project create / update / delete / credential / auto-auth`             |
| `run:tests`      | `test run / rerun / flaky / wait / cancel / artifact get`               |
| `run:tunnel`     | frontend runs that open a tunnel, `tunnel start / list / status / stop` |

New API keys include the full scope set. Backend v0.18.0 or later grants `run:tunnel` to existing keys unless deliberately narrowed; older backends may require a new key. If a command returns `AUTH_FORBIDDEN`, the missing scope is named in `details.requiredScope` — regenerate your key from the dashboard to pick up new scopes.

## Output & scripting

JSON is the stable, machine-readable contract; pipe it straight into `jq` or a coding agent:

```bash
# Grab the runId of a freshly triggered run
RUN_ID=$(testsprite test run test_xxxxxxxx --output json | jq -r '.runId')

# Wait on it and branch on the exit code
testsprite test wait "$RUN_ID" --timeout 600 --output json || echo "run did not pass"
```

## Continuous integration

Run TestSprite as a required check in any CI system: install the CLI, authenticate from the environment, run your tests to a verdict, and let the **exit code** gate the pipeline. JSON output and the [exit-code table](#exit-codes) are the stable automation contract, so nothing here depends on parsing human-readable text.

### GitHub Actions (fastest)

Don't hand-write YAML — scaffold it:

```bash
testsprite ci init github
```

This writes `.github/workflows/testsprite.yml` delegating to the maintained [`TestSprite/testsprite-action@v1`](https://github.com/TestSprite/testsprite-action), which installs the CLI, runs the tests, emits `::error::` annotations plus a job-summary table (each test's title linked to its Portal page and its run linked to the result page), uploads a JUnit report, and **fails the job on a skipped/partial run** instead of reporting it green. See [CI integration (`ci init`)](#ci-integration-ci-init) for every flag and the repo-secret setup.

### Any CI (generic recipe)

The CLI needs only two environment variables — no `~/.testsprite/credentials` file — so it drops into any runner. Store your key as a secret and export it:

```bash
# 1. Install (pin a version in CI — avoid `latest`)
npm install -g @testsprite/testsprite-cli@<version>

# 2. Authenticate from the environment (a masked secret in your CI)
export TESTSPRITE_API_KEY="…"                          # required
export TESTSPRITE_API_URL="https://api.testsprite.com" # only for a non-prod endpoint

# 3. Run every test in a project to a verdict — the exit code gates the job
testsprite test run --all --project proj_xxxxxxxx --wait \
  --report junit --report-file testsprite-junit.xml \
  --summary-file testsprite-summary.json
```

- **`--wait`** blocks until every run is terminal (or `--timeout`, default 600 s), so the exit code reflects the real verdict — `0` only when all tests passed.
- **`--report junit --report-file <path>`** writes a JUnit XML sidecar. Any CI that ingests JUnit — CircleCI `store_test_results`, GitLab `artifacts:reports:junit`, Jenkins JUnit plugin, Azure Pipelines `PublishTestResults` — then shows per-test results, timings, and rerun-failed from it.
- **`--summary-file <path>`** writes a compact machine summary (`{ total, passed, failed, skipped, timedOut, runs[] }`) you can read from any step — `failed` counts only dispatched runs that failed; tests that never dispatched (deferred / conflicted / not found / skipped) count under `skipped`. **`--gh-output`** additionally emits a job-summary table and annotations (`::error::` for failures/timeouts, `::warning::` for never-dispatched tests); it auto-enables under `GITHUB_ACTIONS=true`, so you rarely pass it by hand.

Then archive the sidecar with your platform's test-report step (e.g. CircleCI `store_test_results: { path: . }`, GitLab `artifacts: { reports: { junit: testsprite-junit.xml } }`).

### Full frontend coverage: use a test list

> ⚠️ On a V2 project, `test run --all --project <id>` uses the backend-only batch engine, so frontend tests are skipped and reported under `skippedFrontend`; a batch `--target-url` request is unsupported (exit 7). On a V3 project, `--all` includes frontend and backend tests and `--target-url` applies to frontend tests. For a gate spanning several projects, group the tests into a **test list** and run that:

```bash
testsprite testlist run tl_xxxxxxxx --wait \
  --report junit --report-file testsprite-junit.xml
```

A test list is the addressable unit for a mixed FE/BE, multi-project CI gate; each project runs against its configured environment. See [Test lists (`testlist`)](#test-lists-testlist).

### Gating on the outcome

Under `--wait` the exit code **is** the gate:

| Exit              | CI meaning                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`               | every test passed                                                                                                                                                                                                                          |
| `1`               | at least one test failed or was blocked                                                                                                                                                                                                    |
| `7`               | a run timed out — raise `--timeout`                                                                                                                                                                                                        |
| `5`               | the invocation dispatched **zero** tests (empty project, or a `--filter` that matched nothing). This is deliberate — a gate that greens on zero tests is worse than no gate. Pass `--allow-empty` when an empty run is genuinely expected. |
| `3` / `12` / `13` | auth / out-of-credits / paid-feature-gated — a config problem, not a test failure                                                                                                                                                          |

The full list is the [exit-code table](#exit-codes). On every path the same information is on stdout (or the `error` envelope) under `--output json`, so a script branches without scraping text.

## Exit codes

| Code                  | Meaning                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `0`                   | Success                                                                                           |
| `1`                   | Generic failure / non-passed run status                                                           |
| `2`                   | Not yet implemented                                                                               |
| `3`                   | Auth / missing-scope error                                                                        |
| `4`                   | Not found                                                                                         |
| `5`                   | Validation error / payload too large                                                              |
| `6`                   | Conflict / precondition failed / ambiguous org (see below)                                        |
| `7`                   | Timeout / unsupported                                                                             |
| `10`                  | Service unavailable                                                                               |
| `11`                  | Rate limited (except standing limits such as `tunnel_binding_limit`, not auto-retried)            |
| `12`                  | Insufficient credits (non-retriable)                                                              |
| `13`                  | Feature gated (plan entitlement or per-account flag)                                              |
| `14`                  | Client too old — the backend requires a newer CLI (HTTP 426 `CLIENT_TOO_OLD`); upgrade to proceed |
| `129` / `130` / `143` | Interrupted by a signal (SIGHUP / SIGINT / SIGTERM) — `128 + signal number`                       |

### Exit 7 on `test plan generate` — timeout or unsupported?

Exit `7` is a shared bucket, and on this command it has three producers. The
message text tells them apart:

- **Wait budget elapsed** — `Timed out after <n>s waiting for plan generation on
project <projectId>`, followed by the stage you paused in and how many are left.
  Running the same command again picks up where it left off; raising `--timeout`
  lets one run cover every stage. Under `--output json` the partial object on
  stdout carries the `projectId` and `stagesRemaining` to resume with.
- **Backend does not have these routes yet** — the message names an unsupported
  operation rather than a timeout, and there is no partial object on stdout. Exit
  7 here means _unsupported_, not _slow_.
- **A single request exceeded `--request-timeout`** — the per-request wall clock
  rather than the wait budget. Under a wait the CLI raises that window to cover
  `--timeout`, so this should not fire first.

### Ambiguous org id (exit 6)

For a membership-scoped API key, a testId can — pathologically — resolve to
projects in more than one of your organizations. The CLI prints one
`candidate: project <id> (org <id>)` line per colliding project plus a hint
to re-run with `--project <id>`, and exits `6` (same family as a generic
conflict; retrying does not resolve it). `--output json` carries the same
information in `error.details.candidates`.

### Signals & pipes

During an **ordinary or adopted-tunnel** `--wait`, SIGINT (Ctrl-C), SIGTERM, or SIGHUP gracefully detaches: the in-flight request aborts, stdout receives a partial run result, and stderr names the signal and offers `test wait <run-id>` / `test cancel <run-id>`. The run keeps executing and remains billable; an adopted tunnel stays with its owner. This is distinct from observing that owner disappear, which cancels the borrower's own run by default. Exit codes are `128 + signal` (130 / 143 / 129).

For an **owned `--local` run**, the first signal instead cancels the non-terminal run by default and closes the tunnel. The CLI reports the cancellation outcome; a run cancelled before it finished is refunded. `--no-cancel-on-interrupt` opts out of cancellation and detaches, but the owned tunnel still closes; the same flag also skips an adopted run's owner-gone cancellation. Use a new `test run <test-id> --env <name>` to verify again; `test wait` cannot reopen it. See [local ownership and timeout rules](#local-frontend-testing-and-tunnels).

A second signal exits immediately unless a tunnel credential delete or run cancel is in flight; then the CLI waits up to 2 seconds for critical cleanup. A third signal always exits immediately. Outside a `--wait`, signals keep their immediate-exit behavior, except Ctrl-C on `tunnel start`, which is its normal exit 0. A closed stdout pipe (`EPIPE`, e.g. `testsprite test list | head`) exits 0 silently.

## Design principles

1. **Resource-oriented.** Verbs (`list`, `get`) operate on resources (`project`, `test`, `run`).
2. **Scriptable.** Every command supports `--output json` for machine-readable output.
3. **Stateless.** No local database; the TestSprite backend is the source of truth.
4. **Composable.** Output is pipe-friendly and pairs well with `jq`.
5. **Agent-safe.** Reads that span multiple entities share a `snapshotId` and refuse to stitch data from different runs or code versions.
