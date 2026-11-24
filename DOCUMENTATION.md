# `testsprite` CLI — Documentation

This guide covers TestSprite CLI 0.17. Start with the [quickstart](./README.md#quickstart) to run your first test. For commands supported by an older install, check `testsprite --version` and use the [0.16 reference](https://github.com/TestSprite/testsprite-cli/blob/v0.16.0/DOCUMENTATION.md).

## Contents

- [Install & verify](#install--verify)
- [Upgrading from 0.16](#upgrading-from-016)
- [Manual setup](#manual-setup)
- [The complete agent loop](#the-complete-agent-loop)
- [Agent onboarding (`agent install`)](#agent-onboarding-agent-install)
- [Command reference](#command-reference)
  - [Read commands](#read-commands)
  - [Write commands](#write-commands)
  - [Tests: the project's agent](#tests-the-projects-agent)
  - [Run commands](#run-commands)
  - [Local frontend testing and tunnels](#local-frontend-testing-and-tunnels)
  - [Test lists (`testlist`)](#test-lists-testlist)
  - [Schedules (`schedule`)](#schedules-schedule)
  - [CI gate (`ci run`)](#ci-gate-ci-run)
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

`--dry-run` is a global flag that emits a canned sample matching the API contract without changing your workspace or using credits. A project or multi-test run with `--wait --report junit --report-file <path>` writes a sample JUnit file locally even in dry-run mode. Credentialless previews and explicit targets remain offline. With configured credentials, `run` may make bounded read-only metadata requests to show an automatic tunnel decision; it never mints a tunnel or dispatches runs. It's the right way to confirm an install or learn the surface before configuring auth — the response _shapes_ match the wire contract, but the data is fake.

## Upgrading from 0.16

After upgrading, run `testsprite agent status` in your repository. For each target marked `stale`, refresh its instructions with `testsprite agent install <target> --force`. Update any shell scripts and CI jobs that call the old commands. An old command exits 5, and its error names what to use instead.

| In a 0.16 workflow                                                                                              | In 0.17                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Define, edit or delete a test with `test create`, `test update` or `test delete`                                | Describe the change with `plan`, review the proposal, then `apply`. Attach a spec with `--file` or code changes with `--diff`.           |
| Set the app URL on `project create`                                                                             | Create the project, then add a named target with `project env create <id> --name staging --url <url>`.                                   |
| `test run --all --project P`, `test run T`, `test rerun T`                                                      | `run --project P --wait` for a suite or `run T --wait` for a saved test.                                                                 |
| `testlist run L --case T`                                                                                       | `run T --testlist L --wait`. Omit the positional test IDs to run the whole list.                                                         |
| `test run T --no-auto-heal` for a strict replay                                                                 | Drop the flag. The server decides for each run whether to heal drifted generated code; code a person wrote always runs as written.       |
| `test wait` or `test cancel`                                                                                    | Pass an **execution** ID from `runs[].runId` to `run wait` or `run cancel`. Cancellation covers the whole execution.                     |
| Read history, steps or failure artifacts through `test result`, `test steps`, `test failure` or `test artifact` | Find a **result** ID with `result list --run R` or `result list --test T`, then `result get ID`. Add `--out <dir>` to download evidence. |

In launch and wait JSON, `runs[]` contains executions and the top-level `results[]` contains individual test outcomes. A non-waiting launch can return a run ID before any results exist. A saved 0.16 per-test run ID identifies an individual result in this release. See [Output & scripting](#output--scripting) for a working shell example.

## Manual setup

The recommended path is `testsprite setup` (see the [README quickstart](./README.md#quickstart)). If you prefer to configure each step separately:

### 1. Authenticate

The CLI uses API keys. Create one from your [TestSprite dashboard](https://www.testsprite.com/dashboard-v3/settings/apikey), then configure it:

```bash
# Interactive — prompts for your API key (input is masked); endpoint defaults to prod
testsprite setup --no-agent

# Non-interactive: supply TESTSPRITE_API_KEY through your CI secret or shell environment.
testsprite setup --from-env --no-agent

# Verify
testsprite auth status
```

Credentials are normally stored at `~/.testsprite/credentials` (INI-style, mode `0600`). With `setup --from-env`, an unwritable or read-only HOME (`EACCES`, `EPERM`, or `EROFS` while saving credentials) produces a stderr warning and setup continues using `TESTSPRITE_API_KEY` for this session. Its JSON summary includes `credentials: { persisted: false, source: "env" }`; successful authentication does not mean the key was saved. Keep `TESTSPRITE_API_KEY` available in every shell/process that invokes the CLI. Agent installation still needs a writable destination; use `--no-agent` when only session authentication is needed. Other setup errors still fail. See [Configuration](#configuration) for profiles, environment overrides, and scopes.

Inside a Git repository, `setup` also appends `.testsprite/` (where failure artifacts are written) to the project's `.gitignore` unless it is already ignored, so an agent running `git add -A` does not commit them. The entry is appended, never rewritten; a symlinked `.gitignore` is left untouched with a warning, and a failure to update it is a warning, not a setup failure. Pass `--no-gitignore` to skip this; `--dry-run` only reports it. Outside a Git repository nothing is written.

For an org-scoped API key, `auth status` additionally prints an `orgs:` line (every organization your account belongs to) and an `org binding:` line (the specific organization this key is bound to). Both are omitted for a personal key or an older backend that doesn't report them.

### 2. Create a project

For a new frontend project, set `PROJECT_ID` to the ID printed by the first command. Replace the staging URL with your app's URL. If you already have a project and an environment, find them with `project list` and `project env list "$PROJECT_ID"`.

```bash
testsprite project create --type frontend --name "Checkout"
PROJECT_ID=your-project-id
testsprite project env create "$PROJECT_ID" --name staging --url https://staging.example.com
```

### 3. Get your first tests

Ask the project's agent to propose tests and show you the steps. A backend project can attach an API specification with `--file ./openapi.yaml`. For a frontend available only on your machine, attach a spec or a Git diff, then run the saved tests through a [local tunnel](#local-frontend-testing-and-tunnels).

```bash
testsprite plan "Verify that a guest can complete checkout" --project "$PROJECT_ID" --steps
```

Answer a question in a text message with `testsprite reply "your answer"`. For a question card, pass all answers together in the terminal, for example `testsprite apply --answer 1=b --answer 2=a,c`. Use the letters the card shows. The **Open in the portal** link also lets you answer there. Review a proposed plan and use `reject "what to change"` to request a revision. Applying a test plan saves the cases. Applying a run proposal starts an execution.

```bash
testsprite apply --output json
```

## The complete agent loop

A coding agent can now select one of the saved test IDs from `applied.tests`, or run the whole suite. For a project that already has tests, start here.

```bash
testsprite test list --project "$PROJECT_ID"
testsprite run --project "$PROJECT_ID" --wait --output json
```

For a failed or blocked case, set `RESULT_ID` to its `results[].resultId` and `TEST_ID` to its `testId`. Read the error, failed step and available evidence. After fixing and redeploying the app, launch the same test again. If the test itself needs to change, start a new plan and describe the correction.

```bash
testsprite result get "$RESULT_ID"
testsprite result get "$RESULT_ID" --out ".testsprite/results/$RESULT_ID" --failed-only
testsprite run "$TEST_ID" --wait
```

## Agent onboarding (`agent install`)

`testsprite agent install` writes a ready-made skill/instruction file into your project so your coding agent knows the commands, the exit codes, and how to read a result — no prompt engineering required. It's a pure-local command: no network, no credentials.

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

Three skills are installed by default (`--skill <name>` narrows the set): **`testsprite-verify`** — run the relevant tests after a change, before reporting it done; **`testsprite-onboard`** — seed a repo that has no tests yet with a first suite; **`testsprite-ci`** — put the tests on every pull request: work out how the repo deploys previews, generate the workflow with `ci init github`, finish its placeholder step, set the secret, and prove the gate on one real pull request (see [CI integration](#ci-integration-ci-init)). Each lands in its own file (one managed section for `codex`).

Omitting `--target` installs for the agents the project shows it uses — the calling agent when the environment names one, together with every agent whose own configuration is already in the repo. Both kinds of evidence count, so being called by one agent does not limit the install to that agent. A non-interactive shell (CI, agent subprocess) installs that set with an `[info]` note on stderr naming it; a terminal prompts with it pre-filled — press enter to accept, or give a comma-separated list to narrow it. An unrecognised name is refused outright (exit 5) and nothing is written; re-run to try again. With nothing detected it falls back to `claude` and says so.

`setup`'s prompt is deliberately more forgiving than this one — it re-asks on an unrecognised name and takes `none` to skip. Neither command writes anything before its prompt, so the difference is not about what a refusal would leave behind: `setup` is the onboarding command, usually run once and often by an agent, where a re-run costs a whole round trip; `agent install` is a repair command already being run by hand, where re-running it is the obvious next thing to do. Both prompts accept a name in any case (`Cursor` and `cursor` are the same answer).

`agent status` reports a row for each target and skill. It exits `0` when every row is `ok` or `absent`, including when no skills are installed. It exits `1` for any `stale`, `modified`, `unmarked`, or `corrupt` row. If CI requires a skill, check for an `ok` row for the intended target and skill in `--output json`. Use `--dir <path>` to inspect a different project root.

The `codex` target uses **managed-section mode** — it writes only a sentinel-delimited section inside your existing `AGENTS.md`, so your project instructions are never clobbered. Re-running without `--force` replaces the section in-place; user content outside the sentinels is always preserved.

Re-running with `--force` on **own-file targets** (claude, cursor, cline, antigravity, kiro, windsurf, copilot) backs up the existing file to `<path>.bak` first.

## Command reference

Add `--help` to a command for its options, or `--dry-run` to preview it. See [global flags](#global-flags).

Set the shell variables used in the examples to IDs from your workspace. Get `PROJECT_ID` from `testsprite project list` and `TEST_ID` from `testsprite test list --project "$PROJECT_ID"`. After a launch, use `runs[].runId` for `RUN_ID` and `results[].resultId` for `RESULT_ID`. For examples with two IDs, choose two distinct tests or executions.

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

Get a single project by id. Copy the project ID from `project list` or the response to `project create`.

```bash
testsprite project get "$PROJECT_ID" --output json
testsprite project get "$PROJECT_ID" --dry-run --output json
```

Read the current project instructions here before replacing them with `project update --instruction`. Text output shows the saved lines. In JSON, `instruction` holds the complete stored string or `null` when unset. Older servers omit the field.

When the server supplies an environment summary, text detail shows `defaultEnv:  <name>` and `envs:        <count>`, with a `testsprite project env list <project-id>` hint for a positive count. A reported null default shows `-`; older servers omit both lines. JSON preserves the server's fields without adding missing values.

#### `testsprite test list [--project <id>]`

List the project's test cases as they are written. A nonblank `--project` takes precedence over `TESTSPRITE_PROJECT_ID`. If you omit the flag, the CLI uses `TESTSPRITE_PROJECT_ID`. With neither value set, the command exits 5. Cursor-paginated. Each row is the case alone: `id`, `slug`, `title`, `type`, `category`, `priority`, `version` and `stepCount`; a result is never part of it (`testsprite result list --test <test-id> --limit 1` reads the latest one). Text output has the ID / SLUG / TITLE / TYPE / CATEGORY / PRIORITY / VERSION / STEPS / UPDATED columns.

```bash
testsprite test list --project "$PROJECT_ID" --output json
testsprite test list --project "$PROJECT_ID" --type frontend
testsprite test list --project "$PROJECT_ID" --dry-run --output json
```

Common flags:

- `--type <frontend|backend>` — filter by test type.
- `--page-size`, `--starting-token`, `--max-items` — pagination, same shape as `project list`.
- `--columns <list>`, `--no-header` — text table layout.

#### `testsprite test get <test-id>`

Get one test case by id, with its steps. Test ids come from `test list` (and from `apply`). Text output lists the case's fields, then each step; backend cases echo their dependency declarations — `produces` / `consumes` — when present. When a per-test timeout is set, text output includes `stepTimeout: <N> ms (applies to every step)`. Nothing here is a result: `testsprite result list --test <test-id> --limit 1` lists the latest one, and `testsprite result get <result-id>` reads it.

```bash
testsprite test get "$TEST_ID" --output json
testsprite test get "$TEST_ID" --dry-run --output json
```

Generated test code is inspected in the Portal. The CLI has no stored-code reader.

#### `testsprite result list (--run <run-id> | --test <test-id>)`

A run is one launch of tests; each test in it has a result. `run` prints the run as `runId` and each test's result as `resultId`. `--run` lists one run's results, newest first, results created at the same moment in a fixed order; `--test` lists one test's results across runs, newest first.

```bash
testsprite result list --run "$RUN_ID" --status failed,blocked
testsprite result list --test "$TEST_ID" --limit 5 --output json
testsprite result list --test "$TEST_ID" --env staging --dry-run
```

| Flag              | With     | Meaning                                                                                                                                     |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--status <list>` | either   | `passed`, `failed`, `running`, `blocked`, `cancelled`; comma-separated or repeated, any case. Cancelled results are listed only when named. |
| `--env <name>`    | `--test` | only results from this project environment; an unknown name is exit 5 and lists the valid names                                             |
| `--limit <n>`     | `--test` | how many results, 1–100 (default 20)                                                                                                        |

Exactly one of `--run` / `--test` is required, and `--env` or `--limit` with `--run` is exit 5. Text prints one line per result (`CREATED  STATUS  RESULT ID  RUN ID  ENV  TITLE`), or `No results.`; with `--test`, a stderr note says how many older results your plan's history window hides. The `--run` response includes a `run` object with the execution status. Both queries return `results[]` with `resultId`, `runId`, `caseKey`, `title`, `testStatus` and timestamps. A test history can also include `hiddenRunCount` and `retentionDays`; `testStatus` is upper case. `title` is the title the test had when that result ran. Exit `0` whatever the verdicts; `4` when the run or test is not found. A test's newest result: `result list --test <test-id> --limit 1`, then `result get <result-id>`.

The text output of `result list` and `result get` shows `QUEUED` while a result is waiting for dispatch. On the wire this is `testStatus: "RUNNING"` with `processStatus: "Idle"`, so `--status running` includes queued results.

#### `testsprite result get <result-id>`

One result: the verdict, the error, its cause and fix, the failed step with its screenshot, the step count and the video; a result blocked at sign-in also shows the sign-in run (`signIn`). A backend test also shows its Python traceback (`trace`: the last 20 lines, at most their last 2,000 characters) and its captured output (`apiOutput`: the first 20 lines, at most their first 2,000 characters); when one is cut, a line says what was left out, above the traceback (`(N earlier lines and M characters: …)`) and below the output (`(N more lines: …)`). Both are `null` for a frontend test. A scheduled or test-list backend run has no `trace`: its traceback is in `error`, which is printed in full. `--output json` adds every step, and both in full. Exit `0` whatever the verdict; `4` when the result is not found.

```bash
testsprite result get "$RESULT_ID"
testsprite result get "$RESULT_ID" --output json
testsprite result get "$RESULT_ID" --out ".testsprite/results/$RESULT_ID"
testsprite result get "$RESULT_ID" --out ".testsprite/results/$RESULT_ID" --failed-only
testsprite result get "$RESULT_ID" --dry-run --out ".testsprite/results/$RESULT_ID"
```

With `--out <dir>` it downloads instead of printing, and stdout lists what it wrote (JSON `{ dir, written, failed }`):

| In `<dir>`                                         | What                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `result.json`                                      | the result, each signed link replaced by the file it was written to (`null` if not written) |
| `video.<mp4\|webm\|mov\|mkv\|avi>`                 | the run's video                                                                             |
| `steps/001.png`, `steps/001.html`, …               | each step's screenshot and page, by position                                                |
| `sign-in/video.<ext>`, `sign-in/steps/001.html`, … | a result blocked at sign-in: the sign-in run's video and steps                              |

- Raw HTML snapshots can contain credentials in form values. Exporting under `.testsprite/` creates its default `.gitignore` before the download. Existing ignore rules are preserved. For a custom export path, check which files Git can stage.
- **Use one directory per result**, such as `.testsprite/results/<result-id>`. In an existing `<dir>`, `result.json`, `video.<mp4|webm|mov|mkv|avi>`, `steps/` and `sign-in/` are **deleted and replaced** once the download ends; every other file is kept. Never pass `--out .` or a shared folder. `<dir>` is created if missing, and a symlinked `<dir>` is followed, so do not point it at a path a checkout could plant.
- `--failed-only` keeps the failed steps and one step on each side (every step when none failed); the videos are always downloaded. Without `--out` it is exit 5.
- The files are staged in `<dir>/.testsprite-partial-<random>/` and moved in at the end, so Ctrl-C keeps the earlier download. A process killed outright (SIGKILL) can leave that directory behind; delete it.
- Up to four files download at once, each tried three times. A file that still fails is listed under `failed`, the rest and `result.json` are written, and the command exits `10`; run it again, since each read signs new links. When `<dir>` already holds a download of the same result, a file that fails keeps its earlier copy (`kept: true`, and `result.json` names it).
- A `<dir>` holding a name the filesystem takes for one this command writes (`RESULT.JSON`, `Steps/` on a case-insensitive disk) is refused (exit 5) with nothing changed. If the new files cannot be moved in and the earlier ones cannot all be put back, the command exits `1` and names the `.earlier` folder that holds them.
- `--dry-run` lists what it would write and writes nothing.

### Write commands

Require the `write:projects` scope. Tests themselves are written by the project's agent — see [Tests: the project's agent](#tests-the-projects-agent).

#### `testsprite project create` / `project update`

A project is a name, a type (`frontend` or `backend`) and the settings its agent writes tests with. Where the app runs — URL, test account, sign-in — is an [environment](#testsprite-project-env-list--get--create--update--delete--set-default): create one with `project env create` after the project. A project with no environment cannot run (`no-target-resolvable`), and the first environment you create becomes its default. Projects have **no description field**; descriptions live on tests.

`project create` takes `--type`, `--name`, `--instruction` and `--test-id-attributes`; `project update` takes `--name`, `--instruction`, `--test-id-attributes` and `--clear-test-id-attributes`. `--instruction <text>` is extra guidance for the project's agent, on both project types.

`--test-id-attributes <list>` (also on `project create`) is the project's locator attribute priority list: a comma-separated, ordered set of DOM attributes your app uses as stable test hooks (e.g. `data-element,data-testid`). The execution engine tries them in that order before any other locator strategy when it exports test code, so a tagged element is exported as `page.locator('[data-element="nav.team-selector.trigger-btn"]')`; an attribute whose value is not unique on the page is skipped. `--clear-test-id-attributes` removes the list (engine default: `data-testid`). An older project that does not support the list answers `PRECONDITION_FAILED` (`test_id_attributes_native_only`). Against a backend that predates the field, the CLI answers `UNSUPPORTED` (exit 7, `test_id_attributes_unsupported_backend`) instead of passing through the server's generic 400.

```bash
testsprite project create --type frontend --name "Checkout"
```

Set `PROJECT_ID` to the ID printed by this command. Replace the staging URL with your app's address.

```bash
testsprite project env create "$PROJECT_ID" --name default --url https://staging.example.com
testsprite project update "$PROJECT_ID" --name "Checkout redesign"
testsprite project update "$PROJECT_ID" --test-id-attributes data-element,data-testid
```

**Bootstrap a local frontend project.** Start your app and set `PORT` to its listening port. Create a project for the app.

```bash
testsprite project create --type frontend --name "Checkout"
```

Set `PROJECT_ID` to the returned ID. In the app repository, save the local environment and ask the agent to plan coverage for your Git diff.

```bash
testsprite project env create "$PROJECT_ID" --name local --local "$PORT"
testsprite plan "cover checkout" --diff --project "$PROJECT_ID"
```

Review the proposed plan and apply it when you are ready to save the tests.

```bash
testsprite apply --output json
```

Set `TEST_ID` to one of the returned IDs in `applied.tests` and run it against the local environment.

```bash
testsprite run "$TEST_ID"
```

Creation performs **no exploration**. The project's agent can't open an app on your machine either: attach your change with `plan --diff` and it works from that and the project's other environments; run what it saves through the tunnel with `run <test-id>`.

Portal runs of a local environment are **BLOCKED for free** until a public environment is the project's default:

```bash
testsprite project env create "$PROJECT_ID" --name staging --url https://staging.example.com --set-default
```

Select the environment you want for each run. See [local frontend testing and tunnels](#local-frontend-testing-and-tunnels).

#### `testsprite project env list | get | create | update | delete | set-default`

An **environment** is a named bundle of "how to reach and log in to the app": a URL, a test account (username + password), auto-auth and OTP settings. A project's **default environment** is what a run without `--env` or a run-time target uses: the first environment you create becomes it, and `set-default` moves it. Environments are named (unique within the project), and `run --env <name>` selects one.

```bash
# What does this project have?
testsprite project env list "$PROJECT_ID"
testsprite project env get "$PROJECT_ID" staging

# Read the test account passwords from local files you supply.
testsprite project env create "$PROJECT_ID" --name staging --url https://staging.your-app.com \
  --username qa@your-app.com --password-file ./staging-pw.txt

# An app that only runs on your own machine: name it by its port.
testsprite project env create "$PROJECT_ID" --name local-dev --local 5173 \
  --username dev@your-app.com --password-file ./local-pw.txt
testsprite run "$TEST_ID" --env local-dev

# Update the staging environment and make it the default
testsprite project env update "$PROJECT_ID" staging --url https://staging2.your-app.com
testsprite project env update "$PROJECT_ID" staging --rename preview
testsprite project env update "$PROJECT_ID" preview --clear-credentials
testsprite project env update "$PROJECT_ID" preview --var REGION=west --var TENANT=trial
testsprite project env set-default "$PROJECT_ID" preview
```

To remove the local environment when you no longer use it:

```bash
testsprite project env delete "$PROJECT_ID" local-dev --confirm
```

`create` needs exactly one of `--url <url>` or `--local <port>`. Supported HTTP loopback origins are ordinary environment URLs: `localhost`, `127.0.0.1` and `[::1]`, with an explicit port and no path. `--local` is a shorthand for `http://localhost:<port>`; the deprecated `--local-host` override remains accepted. An optional trailing `/` is preserved; HTTPS, a missing port, other `127.x` hosts, unspecified, LAN, link-local and metadata addresses are refused, and a loopback environment is frontend-only. The port is probed first unless `--skip-preflight` is given. `update --local <port>` or `update --url http://localhost:<port>` changes the stored origin; existing URLs are never normalized or merged. Run a saved environment with `run --env <name>`: its loopback URL opens a tunnel automatically. Passwords come from `--password-file` and are never printed back. `delete` refuses the default environment; deleting any other is a soft delete, so run history keeps naming it.

`get` shows the environment id, name, URL, default status, safe login mode and variables without a password. An older server without the get route returns a clear `UNSUPPORTED` error (exit 7). When creating a frontend environment, choose its mode with `--sign-in public|account|otp|manual`. Change an existing environment’s sign-in mode in the Portal. For OTP, set `--otp-channel email` or `--otp-channel sms`. With manual sign-in, set the reuse window with `--session-ttl <seconds|never>` and capture the login in the Portal. OTP and manual sign-in require a public environment. A manual (SSO) environment shows whether its login is usable (signed in until when, not logged in yet, or expired) and its `session-ttl`; `list` adds the same state to the AUTH column. `get` also prints `portal:`, the environment's page in the Portal, where a manual login is captured. `--output json` returns the server response, including the environment id and `variables`; text `list` stays compact. `update --clear-credentials` removes the username and password and disables account login; it cannot be combined with `--username`, `--password` or `--password-file`.

Use repeatable `--var KEY=VALUE` on `env create` and `env update` to set frontend environment variables. Update merges by key. The first `=` separates key from value, so `--var TOKEN_HINT=a=b` stores `a=b`. Keys must match `^[A-Za-z_][A-Za-z0-9_]{0,63}$` and cannot be `url`, `username`, `password`, `authType`, `credential`, `memory_hints`, `rerun_context`, `__proto__`, `constructor` or `prototype` (case-sensitive). At most 50 keys fit in one environment; a value is limited to 4096 UTF-8 bytes and the total to 32 KiB. Values are plain text in `get` and JSON, so do not use variables for secrets.

Create and update require the server response to confirm requested `--var` values; update also requires confirmation that `--clear-credentials` removed the stored account. If an older server ignores either flag, the CLI exits nonzero and asks you to upgrade or retry. A mixed update's URL may already have changed before that error, so inspect the environment before retrying.

##### API sign-in

A backend project's environment carries how runs sign in to the API under test, the way the project's agent writes it in `environments/<name>.md`: a static credential, the extra headers every request carries, or a sign-in that refreshes the credential. The Portal's environment card edits the same fields, saved through the same server path, so a CLI change and a Portal change produce the same environment. Which endpoint needs which header is decided in the Portal.

```bash
# Supply the credential and header files for your backend test account.
testsprite project env update "$PROJECT_ID" staging --auth bearer --credential-file ./token.txt
testsprite project env update "$PROJECT_ID" review --auth basic --credential-file ./basic.txt
testsprite project env create "$PROJECT_ID" --name prod --url https://api.example.com \
  --auth apikey --credential-file ./key.txt --header "X-Org-Id: 123"
testsprite project env update "$PROJECT_ID" staging --auth none   # send none

# Extra request headers: replace the stored set; secret values from a file
testsprite project env update "$PROJECT_ID" staging --header "X-Org-Id: 123" --header-file ./secret-headers.txt

# A sign-in that refreshes the credential
testsprite project env update "$PROJECT_ID" staging --auto-auth-file ./login.json
```

- For Basic authentication, put a UTF-8 `username:password` pair or its Base64 encoding in the credential file. A file keeps the credential out of your shell history.
- **`--auth`** is `none`, `bearer`, `basic` or `apikey`; the value comes from `--credential-file` (or `--credential`). A new credential keeps the stored type; a new type keeps the stored credential only while the type stays the same. `none` sends no credential and drops the stored one. A static `--auth` replaces a sign-in.
- **`--header "Name: value"`** (repeatable) and **`--header-file`** (one `Name: value` per line) together replace the environment's extra headers. Put a secret value in the file, not on the command line; `get` shows such a header as set, never its value.
- **`--auto-auth-file`** holds a sign-in and is sent to the server as it is: a field the server does not know is refused, a secret left out (`password`, `clientSecret`, `refreshToken`) keeps its stored value, and `"enabled": false` saves it switched off. `method` is `password` (`loginUrl`, `loginBodyTemplate` with `{{username}}` / `{{password}}`, `tokenPath`; optional `loginMethod`, `loginContentType`, `username`, `password`), `refresh_token` (`tokenEndpoint`, `clientId`, `refreshToken`; optional `clientSecret`, `scope`, `tokenPath`) or `aws_cognito_refresh` (`region`, `clientId`, `refreshToken`; optional `tokenPath`). `inject` is `bearer`, `header` or `cookie`; the last two take `injectKey`. Saving it runs a trial login; when that fails the sign-in is saved switched off and `get` shows the error under `auth-error`. Saving a sign-in needs a plan with advanced environment settings (`FEATURE_GATED`, exit 13, otherwise).

  ```json
  {
    "method": "password",
    "inject": "bearer",
    "loginUrl": "https://api.example.com/auth/login",
    "loginBodyTemplate": "{\"email\":\"{{username}}\",\"password\":\"{{password}}\"}",
    "username": "qa@example.com",
    "password": "<secret>",
    "tokenPath": "$.data.accessToken"
  }
  ```

- `get` shows the environment as the agent reads it: `auth`, whether the credential or each sign-in secret is set, the sign-in's settings, and the headers with a secret value shown as `<set>`. A frontend project refuses these flags.

##### Temporary environments for run-time targets

For a frontend run with `--target-url` and no `--env`, TestSprite reuses an environment that already points at the URL's origin. Otherwise a supporting backend creates a temporary environment that clones the default environment's sign-in configuration; an older backend retains its previous temporary-environment behavior. Temporary environments are hidden from `project env list`, do not count toward the environment limit, and are deleted when the run finishes; users cannot create them directly. With `--env <name> --target-url <url>`, the named environment's login and other settings are used against the override URL. The backend refuses a login-once, OTP, or manual-login environment when its origin differs from the target (`PRECONDITION_FAILED`, exit 6). Backend tests still use the URL in their generated code.

#### `testsprite project delete <project-id>`

Permanently delete a project and **everything under it** — its frontend/backend sub-projects, all their tests, and backend fixtures (mirrors the Portal's cascade delete). There is **no restore window**. `--confirm` is required (the CLI never prompts); absent it, the CLI exits 5 with a local validation error. `--dry-run` previews the response shape without a network call. Exit codes: 0 success, 3 auth, 4 not found (or already deleted), 5 validation.

```bash
testsprite project delete "$PROJECT_ID" --dry-run --output json
```

To permanently delete the selected project:

```bash
testsprite project delete "$PROJECT_ID" --confirm
```

### Tests: the project's agent

Tests are written, changed and removed by the project's agent — the same agent the Portal has, in the same conversations. It explores the app in a real browser (frontend) or calls the API (backend), reads what you attach, and proposes changes to the suite as a plan. You apply the plan or reject it with what to change. A coding agent never edits a test: it runs tests, reads their results, and fixes product code.

```bash
# Run in your app repository. Replace the sample file with your own PRD.
testsprite plan "cover the new coupon rules" --diff --file docs/coupons-prd.md --project "$PROJECT_ID"

# A test that is itself wrong goes back to the agent the same way
testsprite plan "the checkout tests fail since the redesign; fix the tests, report real bugs"

# Decide what it proposed
testsprite apply                       # save it (a proposed run is started and waited for)
testsprite apply --exclude 3,CHK-009   # without some tests; --only keeps just the named ones
testsprite apply --answer 1=b --answer 2=a,c   # answer the questions a card asks, by letter
testsprite apply --env staging         # start a proposed run on another environment
testsprite reject "split the coupon test: one for the limit, one for expired codes"

# Reply to a text message from the agent, follow its work, or stop it
testsprite reply "use the qa-admin account for the admin pages"
testsprite status --wait
testsprite stop
testsprite discard                     # drop the task and release what it holds unsaved
```

- **Which project and conversation.** `--project` defaults to `TESTSPRITE_PROJECT_ID`, else the one last used in this folder; `--conversation` defaults to the one last started from this folder.
- **Waiting.** Each command follows the agent until it needs you (a proposal or a reply), printing its progress on stderr. In a terminal there is no limit; otherwise it stops following after 540 seconds (`--timeout <seconds>`), and the agent keeps working — pick it up with `testsprite status --wait`. `--no-wait` returns as soon as the agent has the request.
- **Environment.** A conversation is not tied to an environment. The agent works on the project's default; to have it work on another, name it in your request (`plan "cover checkout on the staging environment"`). Each run the agent proposes names the environment it goes to. For a local-only address, the agent works from your change and project files. Run what it saves with `run <test-id> --local <port>`.
- **What `apply` returns.** The saved test ids (`applied.tests` in JSON) and a `prSummary` you can paste into a pull request description.
- **Documents.** `--file <path>` (repeatable, up to 10 files with the change, 50 MB each) attaches a document; a backend project needs its API spec to plan from.
- **A card that asks questions.** The agent may ask one to four questions, each with lettered options; the conversation shows them numbered. `apply --answer <n>=<letter>` answers question n (letters comma-separated when it takes several), or `--answer <n>="your own words"`. Every question needs an answer, or the card keeps waiting; `reply` is refused while a card waits, and `reject "<what to change>"` turns the card down.
- **A card that starts a run.** The card names the environment the run goes to: the one the agent named, else the project's default. `apply` starts it there; `apply --env <name>` starts it on another of the project's environments instead, as the portal's card lets you pick one.
- **A card that asks for a secret.** When an environment needs a password or a token, the agent asks for it on a card of its own. `apply` takes it from a person typing it in a terminal, or from a pipe with `--secret-stdin` when nobody is at one (`printf '%s' "$PASSWORD" | testsprite apply --secret-stdin`); it is never a flag. Applied without one, nothing changes and the card keeps waiting.
- **Stopping and discarding.** `stop` answers once the agent has stopped, and says so when it was not working. `discard` drops the task: it turns down a waiting card and puts back what the conversation changed and never saved. The conversation reads as discarded until a `reply` picks it up again.

Exit codes: `0` the agent proposed something or replied; `1` the agent stopped before it finished, or the conversation ended; `5` invalid input (no project, a missing file, `--diff` outside a repository); `6` the conversation is not waiting for this (e.g. `apply` with nothing proposed); `7` still working at `--timeout`; `13` the agent is not enabled for this account.

### Run commands

Require `run:tests` (`run wait` needs only `read:tests`; `run cancel` needs both); `tunnel *` needs only `run:tunnel`, and a run that opens a tunnel also needs it.

#### `testsprite run`

```bash
# Run the project and wait for its complete execution
testsprite run --project "$PROJECT_ID" --wait
# Named tests are grouped by their owning project
testsprite run "$TEST_ID" "$SECOND_TEST_ID" --wait
# Saved list, or only named members of that list
testsprite run --testlist "$LIST_ID" --wait
testsprite run "$TEST_ID" "$SECOND_TEST_ID" --testlist "$LIST_ID" --wait
# Resume or cancel execution run IDs, without starting a new run
testsprite run wait "$RUN_ID" "$SECOND_RUN_ID" --timeout 600
testsprite run cancel "$RUN_ID" "$SECOND_RUN_ID"
```

Positional launch IDs always identify tests. `--project` and `--testlist` are
mutually exclusive; `--project` cannot combine with positional IDs. Without
IDs or `--testlist`, `--project` defaults to `TESTSPRITE_PROJECT_ID`; no configured
project is a validation error (exit 5). Named tests and explicit lists ignore
that environment variable. Explicit blank selectors fail instead of falling back.
`--filter` narrows only a project selection. The four former command paths
`test run`, `test wait`, `test cancel` and `testlist run` are removed without
aliases (exit 5). Root `run` rejects `--all` and `--case`: use `--project` and
positional list members instead.

Put lifecycle flags after the child: `run wait <run-id> --timeout 600`.
Launch-only flags before `wait` or `cancel` are rejected; global options such as
`--output json` may precede the child.

Run JSON has the same shape for named tests, project selections, saved test lists and `run wait`. Each `runs[]` entry identifies an execution by `runId`. Each `results[]` entry identifies a test result by `resultId` and carries its `runId`, status and title when known. A dispatch receipt can have an empty results list while the server enumerates the run. Waiting adds a count-only `summary`. A completed failing run exits 1 and includes its results. Only a timeout or interruption that leaves work unfinished adds `partial: true`. Use `testsprite result get <result-id>` for steps, video, screenshots, traceback and failure details. In text mode each run prints `Dashboard: <url>`, its page in the Portal, when the server sends one (`runs[].dashboardUrl` in JSON); a saved list launched without `--wait` prints none, and `run wait <run-id>` does.

Waiting reads the execution's result listing until its authoritative `run.status` is `finished`. Passed results do not finish a run during the gap before integration tests appear. A cancelled execution fails even when its existing results all passed or no results exist. The summary counts each test result once and includes one skipped row per undispatched test. Nonzero counts for blocked and cancelled results and result-read errors appear as `blocked`, `cancelled` and `errors`. Execution-level failures appear separately in `runFailures`. Results with a block explanation carry `TEST_BLOCKED` or a more specific dispatch reason in `errorCode`. Exit 0 means passed, 1 means failed/blocked/cancelled, and 7 means timeout. A deadline or interrupt preserves the latest results and acknowledged launch receipts. Ordinary waits detach with `run wait <run-id>` and `run cancel <run-id>` guidance; owned tunnels cancel unfinished owned executions before closing.

**Several IDs and dependencies.** `run <id> <id> …` groups IDs by project and sends exactly one request per project, without chunking or client dispatch pacing. Each named project selection has a 5000-ID payload limit; exceeding it fails before dispatch. Unfiltered public `run --project <id>` sends no `testIds`, leaving selection to the server. `--skip-dependencies` requests only the selected backend tests; the server owns dependency expansion and dispatch.

If a later request fails, output retains earlier launch receipts. `notRunProjects` names projects not launched; `unconfirmedProjects` identifies requests that may have started but returned no receipt, with their per-project request keys. Inspect those projects before retrying. To replay the original command, pass the top-level `retryIdempotencyKey` to `--idempotency-key`. Server error messages, actions and details are preserved. No later project is submitted after a failure.

**Queueing and held tests.** The server queues execution work and applies `--max-concurrency` to each execution. `blocked[]` identifies seeded blocked results; `held[]` identifies tests already owned by another run. Waiting can join only verified matching held results, scoped to their result IDs. Incompatible held work is retained with a separate skipped diagnostic; CI's `--fail-on-skipped` controls that gate. No held work is resubmitted. `--allow-empty` explicitly permits a launch with no newly dispatched tests.

`run --project <id>` runs the project's tests, including later integration work. `--target-url` applies to frontend tests. For a backend project outside a CI preview, the override is ignored, omitted from the launch request and explained on stderr; `--env` still selects its environment. A CI pull-request preview clones that environment with the preview target and runs against the clone.

With a project selection, `--filter <substr>` narrows the selection to test names containing a non-empty substring (case-insensitive); omit the flag to run every project test. An explicitly empty value (`--filter ""` or `--filter=`) fails with `VALIDATION_ERROR` / exit **5** before any request, including on `--dry-run` paths. Non-empty values are used as written, including whitespace.

`testsprite run list` — a literal `list` where a test id goes — is a usage error (exit 5), not a run against a test named "list": there is no `run list` subcommand. It points you at `result list --test <test-id>`, which lists a test's results across runs.

The server decides whether a fresh run heals drifted generated code. When healing is on, the agent re-authors stale code and runs the new version instead of replaying a script that can only fail, and saves the new code as the test's stored version. Code a person wrote (a hand-edit in the portal) is never re-authored: it runs as written. There is no flag for this on `run`; the launch's `autoHeal` in `--output json` says what the server decided.

```bash
# Trigger and return immediately
testsprite run "$TEST_ID" --output json

# Trigger against a run-time URL and wait for terminal status
testsprite run "$TEST_ID" --target-url https://staging.example.com \
  --wait --timeout 600 --output json

# Dry-run previews the project request without dispatch or tunnel writes
testsprite run "$TEST_ID" --dry-run --output json

# Batch run with JUnit XML for CI (sidecar; --output json unchanged)
testsprite run --project "$PROJECT_ID" --wait \
  --report junit --report-file ./results.xml --output json

# Optional custom suite name (default: testsprite:<projectId>)
testsprite run --project "$PROJECT_ID" --wait \
  --report junit --report-file ./results.xml --report-suite-name my-ci-suite --output json

# GitHub-native CI output: ::error:: annotations + job-summary table + machine summary
testsprite run "$TEST_ID" --wait --summary-file ./summary.json --output json
```

Use `--report` with `run --wait` for a project, several test IDs, or a saved test list. `--report junit --report-file <path>` writes a JUnit XML sidecar after polling completes (atomic write); `--output json` is unchanged. Optional `--report-suite-name <name>` overrides the default `testsprite:<projectId>` suite name.

If a wait is interrupted, results whose last observed status was `running` count toward `summary.running`. GitHub Actions omits error annotations for those rows. JUnit records them as skipped with the reason `Still running when the wait ended`. Actual failures keep their verdicts.

**GitHub-native CI output** (contributed in [#264](https://github.com/TestSprite/testsprite-cli/pull/264)): when `GITHUB_ACTIONS=true`, `run <test-id> --wait`, project or named batches with `--wait`, and `run --testlist <list-id> --wait` additionally emit one workflow-command line per failed, timed-out or undispatched test (annotating the PR checks tab — `::error::` for a dispatched test that failed or timed out, `::warning::` for a test that never dispatched) and append a Markdown results table to the job summary (`$GITHUB_STEP_SUMMARY`). Pass `--gh-output` to force the annotations outside Actions (previewable locally), and `--summary-file <path>` to also write the reduced machine summary JSON (`{total, passed, failed, blocked?, cancelled?, errors?, skipped, timedOut, running?, results[]}`, one row per test with its `resultId` and `runId`). Everything is written even when the command exits non-zero — including a batch where nothing dispatched at all (every test already in flight → exit 6, or every test rate-deferred → exit 7), which still surfaces its verdict in CI rather than failing silently. Every write is best-effort — a failed write never changes the exit code. Tests that never dispatched (rate-deferred, conflicted, not found) appear as non-passed rows counted under `skipped` — never under `failed`, so the artifact always agrees with the exit code — and a partial batch still cannot read as all-passed. Annotation and table content is escaped, so run-error text cannot inject workflow commands or break the table.

**Preview targets.** Use `--target-url` for a frontend preview. For backend tests, select the API's saved environment with `--env`. In a GitHub pull request, `ci run --env <name> --target-url <url>` can clone that environment at the preview address. Backend code that reads `VAR_{url}` uses the selected environment's URL. A hard-coded URL keeps its original destination. See [CI integration](#ci-integration-ci-init).

`--target-url` accepts public URLs and supported loopback URLs such as `http://localhost:3000`, `http://127.0.0.1:3000` and `http://[::1]:3000`. A loopback target on `run` uses the same tunnel path as `--local <port>` with that host. Other private, unspecified, link-local and metadata addresses remain refused. Tunnels are frontend-only and need `run:tunnel`; a scope refusal names the missing scope (exit 3). Existing keys receive it on backend v0.18.0 or later unless deliberately narrowed.

**`--env <name>` — the origin and sign-in configuration.** Select a named environment, or omit it for the project default (see [`project env`](#testsprite-project-env-list--get--create--update--delete--set-default)). A saved loopback URL automatically opens a tunnel on frontend `run` (one/many/project selection) and `run --testlist <list-id>`. The stored URL is sent verbatim, so `localhost`, `127.0.0.1` and `[::1]` remain distinct origins. `--no-wait` disables automatic tunneling; drop it to run through a tunnel. If the environment list cannot be read, the CLI sends the previous request and renders the server's refusal. Backend tests keep their previous cloud behavior.

`--target-url` and `--local` can supply an ad-hoc origin while `--env` supplies its sign-in configuration and run attribution. When no saved origin matches and no `--env` is selected, a supporting backend clones the project default's sign-in configuration into a temporary environment. Explicit `--local` can use a public environment's sign-in configuration on a new backend; an older backend's refusal is rendered verbatim and the tunnel is closed. Unknown environment names remain validation errors with the available names. `--env` is accepted by project and named-test selection; saved lists use their pinned environment mappings.

**Reachability before launch.** The CLI checks a public target from the machine running the command. A confirmed DNS failure, refused connection, gateway error or redirect to a protected Vercel login can stop dispatch with exit 5. An inconclusive probe prints a warning. For a loopback target the CLI checks the local listener. Use `--skip-preflight` when the runner can reach a target that this machine cannot probe.

If a project launch receipt reports an unexpected target URL or environment, or a concurrency limit above the one requested, the CLI exits 7 (`UNSUPPORTED`). With `--output json`, read `error.details.field` on stderr (`targetUrl`, `environment`, `previewName` for a CI preview, or `maxConcurrency`). Use `error.details.runId` to inspect the execution before retrying.

For a retry of the same command, pass the single key printed to stderr as `--idempotency-key`. A single-project launch uses this key unchanged. Multiple projects get deterministic project-specific suffixes, shortened with a digest when needed to stay within 256 characters. There are no chunk suffixes. Reuse the same key only with the same request body; changing a tunnel binding changes the body and can produce an idempotency mismatch. Inspect an unconfirmed launch before retrying.

**When a wait fails**, inspect stdout for acknowledged executions and test outcomes, and stderr for the error code and recovery hint. A transient throttle can be retried up to the wait deadline. A standing rate limit exits 11. When a saved list leaves members undispatched, check their individual reasons and address them before launching again. [Exit codes](#exit-codes)

#### Local frontend testing and tunnels

A tunnel connects the cloud frontend runner to an app running on your machine. Ordinary test credits apply. The API key needs `run:tunnel` as well as permission to run tests. Check the workspace balance with `testsprite usage`.

**Transport security and bounded retry.** The control plane is WebSocket over TLS at `wss://control.tun.testsprite.com/ws`. The data plane carries both the tunnel secret and proxied traffic over TLS at `data.tun.testsprite.com:443`, with the certificate verified by Node's default trust store: its bundled Mozilla roots, plus certificates supplied through `NODE_EXTRA_CA_CERTS` and the system CAs when Node is started with `--use-system-ca`. Node 20 retains `NODE_EXTRA_CA_CERTS` when explicit roots are also configured. Certificate verification cannot be disabled, and the CLI never falls back from TLS to plaintext. On a network that re-signs TLS, export your organisation's root CA to a PEM file and set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` before running `testsprite`. Plaintext connects and TLS handshakes each have a 10-second timeout. The first failed attempt opens a **60-second** retry episode. A successful `TunnelHello` write does not establish the session: only the first inbound tunnel stream or a socket that remains open for 5 seconds after the hello ends the episode. The deadline remains armed across backoff and later attempts, destroys any in-flight socket when it expires, reports one terminal data-plane error, and stops the client. An owned `run --local` run is then cancelled (the server attempts a refund) and the command exits **10**; `tunnel start` exits **10**. Intentional shutdown reports no data-plane error. When a self-hosted or older TestSprite server does not advertise a TLS endpoint, the CLI instead prints a one-time warning and uses the legacy plaintext data port **7400** under the same retry rules. `tunnel start` makes the selected mode visible as `transport: tls` or `transport: plaintext`.

```bash
# A saved loopback environment opens a tunnel and waits automatically
testsprite run "$TEST_ID" --env local-dev --output json
# Or supply an ad-hoc loopback target
testsprite run "$TEST_ID" --target-url http://localhost:3000 --output json
# Several frontend tests share one tunnel and run five at a time by default
testsprite run "$TEST_ID" "$SECOND_TEST_ID" --local 3000 --max-concurrency 5 --output json
testsprite run --project "$PROJECT_ID" --local 3000 --output json
# A different loopback listener, or a longer run
testsprite run "$TEST_ID" --env local-dev --timeout 1800
```

| Flag                          | Local-run behavior                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--local <port>`              | Frontend only; port 1–65535. Opens one tunnel for the invocation and implies `--wait`. Mutually exclusive with `--target-url` (exit 5).                                                                                                                                                                                                                                                                 |
| `--max-concurrency <n>`       | With a tunnel, the server dispatch limit for each project execution: 1–15, default **5**. The command has one shared wait deadline; no client-side capacity loop splits the limit.                                                                                                                                                                                                                      |
| `--local-host <host>`         | With `--local` only; `localhost`, `127.0.0.1`, or `::1`. Deprecated on project/environment writes. The shorthand defaults to the selected loopback environment's host, else the one host agreed by saved non-temporary loopback environments on that port, else `localhost`; unreadable lists retain `127.0.0.1`. Chooses the loopback name in the run's target URL; LAN/RFC1918 addresses are refused. |
| `--tunnel-client <client-id>` | Borrows the non-secret client id from `tunnel start` for a loopback target or selected environment. Still implies waiting, but ownership stays with the separate tunnel process.                                                                                                                                                                                                                        |
| `--timeout <seconds>`         | 1–3600; default **600** for ordinary waits, **1200** for tunnel runs, including adopted tunnels.                                                                                                                                                                                                                                                                                                        |
| `--no-cancel-on-interrupt`    | For tunnel runs; opts out of automatic cancellation when an owned tunnel closes or a borrowed tunnel's owner disappears. The run can no longer reach the app and remains billable.                                                                                                                                                                                                                      |
| `--skip-preflight`            | Skips the local port probe. Normally a dead port is refused before minting a tunnel or charging a run (exit 5). It does not bypass flag, scope, or backend preconditions.                                                                                                                                                                                                                               |

The flags and limits above describe named-test and project runs. A [saved test list](#test-lists-testlist) opens a tunnel from its configured environment. For a list with a tunnel, `--max-concurrency` accepts 1–10 (default 5), and `--timeout` defaults to 600 seconds. List mode does not accept `--local`, `--tunnel-client`, or `--no-cancel-on-interrupt`.

**Concurrency.** Run several frontend tests with `run <id> <id> … --local <port>` or all frontend tests in a project with `run --project <id> --local <port>`. One invocation mints one binding and sends one launch request per project, with at most 5000 named IDs and no client chunking. `--max-concurrency` is the server limit for **each execution** (1–15, default **5**); it is not a shared budget divided across runs. `run --project <id> --local <port>` reports backend tests as skipped. A user can have **5 live tunnel bindings**. The `tunnel_binding_limit` reason is exit 11 and is **not auto-retried**: stop an unused tunnel or reuse an existing one with `--tunnel-client` before retrying. Ctrl-C cancels owned unfinished executions by default and prints one partial JSON object with acknowledged native references, cancellation receipts and unattempted or unconfirmed projects; tunnel loss also cancels owned work and exits 10. A backend that does not confirm the tunnel or an effective cap no greater than requested has its acknowledged owned executions cancelled, and the command exits 7. The minted client ID is printed before connecting so a failed connection still identifies the binding.

**Login and execution.** Tunnels serve frontend tests. An explicit loopback target on a backend test fails client validation (exit 5); single backend tests keep their previous cloud path; tunnel batches skip only backend tests whose own selected environment is loopback, and include their IDs in `skipped`. Public-environment backend tests dispatch normally. The project environment's username/password are passed to the cloud agent, which logs in inline through the tunnel. OTP environments are refused **before charge** with exit 6 (`tunnel-otp-auth-unsupported`). `--local` runs always use the agent path, never saved-code replay, and **do not overwrite the test's saved code**. Test-list tunnel launches use one `--timeout` deadline and have no client capacity waits. Distinct effective target URLs may form separate requests, each with the same requested server cap. Explicit public-environment sign-in against a local origin is announced once on stderr. Test-list responses must confirm the tunnel client ID and a positive integer effective cap no greater than requested; a missing or invalid confirmation causes owned executions to be cancelled and exits with a clear error.

**Timeout, cancellation, and refunds.** Local runs share one `--timeout` deadline across whole executions, including queued work and later integration results. There are no per-test timers, wave allowances or client-side concurrency shares. When an owned tunnel stops waiting before execution completion, the CLI cancels its unfinished owned executions by default and closes the tunnel. This includes deadline expiry (exit 7), Ctrl-C (exit 130), and non-terminal polling or tunnel failures. Cancellation can race completion or fail; read the reported outcome instead of assuming it succeeded. The server attempts settlement for cancelled results regardless of test type; each `refund` reports `refunded`, `not_charged` or `failed`, and a failed refund can be retried by cancelling the same run again. Finished verdicts are not replaced. After an owned local timeout, start a **new** run with `testsprite run <test-id> --env <name> --timeout 1800`; `run wait` cannot restore the closed tunnel. `--no-cancel-on-interrupt` detaches instead, but does not keep an owned tunnel alive.

A borrowed `--tunnel-client` run is not cancelled on Ctrl-C/SIGTERM: the borrower detaches, never closes or deletes the adopted tunnel, and `run wait <run-id>` can resume polling while the owner keeps it alive. If liveness reports that the owner is gone while the run is non-terminal, the borrower cancels **its own run** exactly as an owned doomed run does. The message names the run id and the observed result (`cancelled`, `already finished`, or `skipped`), then points to the run read before a retry. For a frontend test cancelled before a terminal verdict the server attempts a refund; read the reported `refund`. `--no-cancel-on-interrupt` skips the owner-gone cancel too, leaving the run executing and billable without a working tunnel.

**Retargeting a local case.** Cloud runs such as Portal Run and schedules cannot reach a loopback environment and are **free BLOCKED** with reason `tunnel-required`. A CLI frontend run opens a tunnel when the resolved saved environment is loopback. Select that environment with `--env <name>`, or explicitly retarget the case using `run <test-id> --target-url https://staging.example.com`. For a project whose default environment is loopback, add a public environment and make it the default (`project env create <id> --name staging --url https://… --set-default`) to enable Portal runs.

#### `testsprite tunnel start` / `list` / `status` / `stop`

Start the tunnel in one terminal. In a second terminal, set `CLIENT_ID` to the ID printed by the first and `TEST_ID` to a saved frontend test. This example uses an app listening on port 5173.

```bash
# Terminal A — no positional port; keep this process running
testsprite tunnel start --ttl 3600
```

```bash
# Terminal B — use the printed client ID and the port your frontend listens on
testsprite run "$TEST_ID" --env local-dev --local 5173 --tunnel-client "$CLIENT_ID"
testsprite tunnel list
testsprite tunnel status "$CLIENT_ID"
testsprite tunnel stop "$CLIENT_ID"
```

To revoke **all** live bindings on the account, including those used by other terminals and CI jobs:

```bash
testsprite tunnel stop --all --confirm
```

`tunnel start` runs in the foreground; there is no daemon. It prints the client id and expiry to stderr immediately after minting, before attempting to connect, then prints the selected `transport: tls|plaintext` alongside the client id, expiry, and online status. The secret stays in memory. `--ttl <seconds>` requests a credential lifetime of **60–28800 seconds** (the server clamps the value; the CLI requires a positive whole number). The credential is deleted when the owner exits, regardless of TTL. Ctrl-C on `tunnel start` is a normal stop (exit 0); service disconnection or observed credential revocation is exit 10 (`UNAVAILABLE`). A selected data-plane transport that never becomes established is retried for up to 60 seconds before the same exit 10.

`tunnel list` shows every live binding for this account, with its client id, connection status, creation time and expiry; `unknown` means TestSprite could not check the connection at that moment. JSON returns `{ tunnels: [...] }`. An empty list succeeds. Listing needs `run:tunnel` (auth exit 3); an older server without the route returns exit 4 with guidance to stop a known id or wait for expiry.

`tunnel status <uuid>` and `tunnel stop <uuid>` require a UUID; a non-UUID is rejected locally with exit 5, including under `--dry-run`. Status returns exit 0 even for an explicit `offline` response; an absent binding is exit 4, and an API/transport failure is reported as an error rather than relabelled offline.

Stop is idempotent and prints **`Tunnel credential <uuid> revoked (or already absent).`**; JSON stays `{ clientId, deleted: true }`. A running `tunnel start` exits **10** immediately on the server's revocation close, with its approximately **15-second** status cadence as a backstop. Stop itself does not issue run cancellation; an attached borrower that observes the owner gone cancels its own non-terminal run unless `--no-cancel-on-interrupt` was passed.

Hit the tunnel limit? List your bindings with `testsprite tunnel list`, then stop an unused one with `testsprite tunnel stop <client-uuid>`. `testsprite tunnel stop --all --confirm` revokes every live binding on the account, including bindings owned by another terminal or CI job. It deletes sequentially, reports each result, and exits 1 if any stop fails. `testsprite --dry-run tunnel stop --all` uses sample ids and makes no real deletion; run `tunnel list` to see the actual bindings before confirming.

A second `tunnel start` or process using the same credential takes over, and the first exits **10**. Dev servers can take a minute per page through the tunnel; for a heavy dev server, test a built server with `npm run build`, then the framework's preview/start command.

| Exit | Meaning and next step                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `3`  | Authentication/scope error; if `run:tunnel` is missing, mint a new API key.                                                                          |
| `5`  | Validation: dead local port, invalid port/host/UUID, incompatible flags, or no runnable frontend tests in a local batch (unless `--allow-empty`).    |
| `6`  | Precondition, including `tunnel-required`, `tunnel-offline`, or `tunnel-otp-auth-unsupported`; resolve the named condition before retrying.          |
| `7`  | Wait timeout or unsupported operation, including `tunnel-unsupported-for-backend-test`. An owned local timeout requires a new run, not reattachment. |
| `10` | Unavailable: transport/service failure, tunnel lost, or the owner observed revocation/expiry.                                                        |
| `11` | Rate limited, including `tunnel_binding_limit`; the binding-cap reason is not auto-retried.                                                          |

#### `testsprite run wait <run-id...>`

Wait for each execution's authoritative `run.status` to become `finished`,
including integration results added after earlier results passed. A cancelled
execution fails even with an empty or all-passed result list. Each read includes
all result statuses. One shared `--timeout` (default 600 seconds, maximum 3600)
bounds the wait. Each distinct run is read independently, without a polling
concurrency flag; execution dispatch limits belong to `run` and `run --testlist <list-id>`.

```bash
testsprite run wait "$RUN_ID" "$SECOND_RUN_ID" --timeout 900 --output json
```

JSON includes `runs[]` for execution receipts, top-level `results[]` for individual results and `summary` for counts. A timeout
or interrupt preserves the last observed results. Resume an ordinary run with
`run wait`; this cannot reopen a closed owned tunnel. Read detailed evidence
with `testsprite result get <result-id>`.

Transient outages and throttling are retried within the shared deadline. A
persistent outage exits 10 with its original server envelope; a transient
throttle still pending at the deadline is timeout 7. Standing-condition 429
errors retain exit 11. Auth, not-found, server and transport errors keep their
normal classification. One final bounded read can observe a last-minute verdict
within a two-second grace. Local resume/cancel advice is separate from server
error messages and actions.

#### `testsprite run cancel <run-id...>`

Send one cancellation POST per unique execution, without first listing members.
The server owns current and later membership, terminal races and refunds.
An already finished or cancelled execution is an idempotent HTTP 200 result.

```bash
testsprite run cancel "$RUN_ID" "$SECOND_RUN_ID" --output json
```

JSON contains native cancellation responses in `runs[]`, with `runId`,
`alreadyCancelled`, `alreadyFinished` and per-result status/refund rows. Summary
arrays name executions; errors carry `runId`. A first signal retains responses
so far, `interrupted` and `notAttempted` execution IDs, then exits 128 + signal.
Per-result refunds can be `refunded`, `not_charged` or `failed`, for frontend and
backend tests alike. A failed refund is visible and retryable by cancelling the
same run again. Finished verdicts are not overwritten.

Ordinary waits detach on Ctrl-C. An owned tunnel instead cancels each unfinished
owned execution once and closes, unless cancellation was explicitly disabled.
Borrowed tunnels stay open; joined results are never owned by the CLI.

### Test lists (`testlist`)

A **test list** is a saved, named collection of tests — the CLI surface for the portal's `Tools → Test Lists`. A list can span multiple projects, and each project in it can be pinned to a specific environment (`--project-env <projectId>:<envName>`) so `run --testlist <list-id>` executes every case against the environment the list configured. `testId` on the wire is the logical test id (the same id `test list` / `test get` return); no translation is needed.

Set `LIST_ID` from `testsprite testlist list` or the ID returned by `testlist create`. For two projects, choose `PROJECT_ID` and `SECOND_PROJECT_ID` from `testsprite project list` and substitute their saved environment names. To run a subset, choose two test IDs already in that list.

```bash
testsprite testlist list                                  # all lists visible to the key
testsprite testlist list --output text                    # aligned table (ID / NAME / CASES / LAST RUN / UPDATED)
testsprite testlist get "$LIST_ID"                         # the list with its cases + pass/fail stats

# Write (each mutation takes an auto-minted Idempotency-Key; pass --idempotency-key to control it)
testsprite testlist create --name "Checkout smoke" \
  --project-env "${PROJECT_ID}:staging" --project-env "${SECOND_PROJECT_ID}:prod"
testsprite testlist update "$LIST_ID" --name "Renamed"     # rename
testsprite testlist update "$LIST_ID" --project-env "${PROJECT_ID}:prod"   # replace the env mapping
testsprite testlist update "$LIST_ID" --clear-project-env  # remove all env mappings (distinct from omitting the flag)
testsprite testlist add "$LIST_ID" "$TEST_ID" "$SECOND_TEST_ID"            # add tests

# Run — dispatch the list's cases and return pollable run ids
testsprite run --testlist "$LIST_ID"                         # prints the launch receipt; results may arrive later
testsprite run "$TEST_ID" "$SECOND_TEST_ID" --testlist "$LIST_ID"   # run only a subset
testsprite run --testlist "$LIST_ID" --wait --timeout 600 --output json  # wait for each execution to finish
testsprite run --testlist "$LIST_ID" --wait --report junit --report-file ./results.xml
```

To remove specific cases from the list:

```bash
testsprite testlist remove "$LIST_ID" "$TEST_ID" "$SECOND_TEST_ID"
```

To delete the list and its schedules:

```bash
testsprite testlist delete "$LIST_ID" --confirm
```

List mode uses each project's pinned environment or its default. Update a pin with `testlist update --project-env`. The launch takes its selection from list membership and any positional test IDs. Launch overrides such as `--env`, `--local` and `--target-url` are unavailable here. Use named or project selection when you need these options.

`runs[].runId` identifies each execution. `results[].resultId` identifies each individual outcome. A list can produce multiple executions. A saved loopback environment opens a tunnel and waits automatically. Otherwise add `--wait` for a verdict. List concurrency defaults to 10 (range 1–50), or 5 with a tunnel (1–10). The default wait is 600 seconds in either case.

If only some positional IDs belong to the list, `notFound` contains the others and the command exits **4**. With `--wait`, it polls the matched tests first, so a failed run (**1**) or a timeout (**7**) takes precedence. With or without `--wait`, if every member conflicts, the command exits **6** (**12** for insufficient credits, **13** for a billing hold). Rate deferral can also cause exit **7** in either mode. An empty list can exit **0**.

Use `--wait --summary-file <path>` for a machine summary, or `--wait --report junit --report-file <path>` for a JUnit report.

When a list dispatches only some members, the text output names each refused
member and its reason and shows how many did not dispatch. A CI job that
requires every member to run can check the JSON summary with `jq`:

```bash
testsprite run --testlist "$LIST_ID" --wait --output json > run.json &&
  jq -e '.summary.total > 0 and .summary.skipped == 0' run.json
```

Every mutation (`create`/`update`/`delete`/`add`/`remove`) is refused with a billing-hold envelope on a **paused** team workspace (matching the portal's read-only wall); `delete` also removes the list's schedules and their triggers, so it requires `--confirm`. All commands accept the global `--output json|text` and `--dry-run` (offline shape-accurate sample).

### Schedules (`schedule`)

A **schedule** runs a project or a test list on a cron, unattended — the CLI surface for the portal's Monitoring view. Every firing is a full test run, billed like any other, so the CLI states how often a cron works out to **before** it sends the request. Schedules are **entitlement-gated**: a plan that does not include them gets `FEATURE_GATED` (exit 13), and an account or backend that does not serve schedules at all gets `UNSUPPORTED` (exit 7).

Use a test-list ID or project ID for the target. Set `SCHEDULE_ID` from `testsprite schedule list` or the schedule creation output. For the environment update, use the ID of a project-target schedule as `PROJECT_SCHEDULE_ID`.

```bash
# Read
testsprite schedule list                       # table: ID / NAME / STATUS / TARGET / ENVIRONMENT / CRON / TZ / LAST RUN
testsprite schedule list --columns id,name,cron --no-header   # pick + reorder columns for scripts
testsprite schedule get "$SCHEDULE_ID"          # one schedule, one field per line

# Create (each mutation sends an auto-minted Idempotency-Key; pass --idempotency-key to control it)
testsprite schedule create --name "Nightly checkout" \
  --target-type testList --target-id "$LIST_ID" \
  --cron "0 3 * * *" --timezone America/New_York \
  --send-to oncall@example.com,qa@example.com
testsprite schedule create --name "Staging nightly" \
  --target-type project --target-id "$PROJECT_ID" --env staging --cron "0 3 * * *"

# Update, pause, resume
testsprite schedule update "$SCHEDULE_ID" --name "Renamed"
testsprite schedule update "$PROJECT_SCHEDULE_ID" --env staging
testsprite schedule update "$SCHEDULE_ID" --cron "0 6 * * 1"   # re-states the new frequency first
testsprite schedule update "$SCHEDULE_ID" --pause              # stop it firing, keep the schedule
testsprite schedule update "$SCHEDULE_ID" --resume
```

To permanently remove the schedule and its run history and stop future triggers:

```bash
testsprite schedule delete "$SCHEDULE_ID" --confirm
```

**Target.** `--target-type project` runs the project's **entire live suite** on every tick — there is no way to schedule a subset of a project's tests, so use a test list for that. `--target-type testList` runs the list's cases, each through its project's configured environment (see [Test lists](#test-lists-testlist)). `--target-id` is the matching project id or test-list id, and a target that does not resolve is a `404` (exit 4). Deleting a test list also deletes its schedules.

**Environment.** On a project target, `--env <name>` pins the schedule to that environment name. Without it, a new schedule uses the project's live default at each tick; changing the default changes future ticks. An unknown or deleted name fails validation rather than falling back. `schedule update --env` pins an existing project schedule; omitting it leaves its current mode unchanged. There is no unpin flag. Test-list schedules inherit the list's live per-project bindings: change those with `testsprite testlist update <testlist-id> --project-env <projectId>:<environmentName>`. `schedule create --target-type testList --env` fails locally (exit 5); `schedule update --env` sends the request and the API rejects it if that schedule targets a test list. Blank `--env` values fail locally (exit 5).

Text output derives `staging (pinned)`, `project default (inherits)` or `-` from the API response. The list's `ENVIRONMENT` column is appended after all existing columns; get/update append the environment detail line. JSON preserves exact `environment` and `environmentMode` fields, including `null` or omission. For explicit `--env`, the CLI first reads existing schedules: a project schedule with no environment mode proves the server is too old and returns `UNSUPPORTED` (exit 7) before a write. An empty or unreadable list is inconclusive, so response confirmation still applies. An unconfirmed create is best-effort deleted, reporting the exact created id and whether it was removed; an unconfirmed update reports the schedule id and other requested fields that may have been applied. Commands without `--env` add no capability read and retain their previous output when the server omits environment fields.

**What a project tick dispatches.** The project's own type decides how its cases run: a **frontend** project's cases go through a shared rolling pool, so a nightly cannot open the whole suite's browser sessions against your site at once — the same cap a portal-triggered run gets; a **backend** project's cases are dispatched together as one fan-out — a scheduled tick does not currently order them producers-before-consumers the way `run --project <project-id>` does. Integration cases are not dispatched as targets: a full run re-assembles them from the units they compose once those have run, which is also why the per-run cost counts only the non-integration cases.

**Cron.** `--cron` is a standard 5-field expression — `minute hour day-of-month month day-of-week` — where day-of-week is `0-7`, with both `0` and `7` meaning Sunday. Constrain day-of-month **or** day-of-week, not both. `--timezone` takes an IANA zone and defaults to `UTC`. `--start` (default: a few minutes from now) and `--end` (default: open-ended) take ISO 8601 instants.

**The frequency is stated before the request, the cost as soon as the server prices it.** `create` — and `update --cron`, since retiming an existing schedule is the same order-of-magnitude mistake as creating one badly — print the frequency to stderr before sending, so a `*/5` typo is visible before it bills. The cost line follows the response, because the price comes from the API — except under `--dry-run`, which prints both offline against a canned figure:

```console
$ testsprite schedule create --name Nightly --target-type project --target-id "$PROJECT_ID" \
    --cron "0 3 * * *" --dry-run
This schedule will run ~30 time(s)/month (daily at 03:00). Each run is a full run. Check your balance with `testsprite usage`.
[dry-run] sample response — not from the server
Estimated cost: ~5 credits/run, ~152 credits/month, based on the target's current case count.
id: sch_dryrun_2026
environment: project default (inherits)
```

Both lines also appear under `--dry-run`, so that is reproducible offline with no key exactly as shown — the id and the per-run figure are the canned dry-run sample; a real create prices the run from the API. Compare a mistyped `--cron "* * * * *"`, which reads `~43800 time(s)/month` and `~219000 credits/month` before anything is created.

Outside `--dry-run` the cost line appears only when the API priced the run — no rate is invented locally. The per-run figure keeps up to two decimals, trailing zeros trimmed (rounding it to whole credits would stop the monthly total beside it from multiplying out); the monthly total is that price times the cron's frequency, rounded to whole credits, and is omitted for an expression the CLI cannot read. A cron it cannot read still gets the frequency advisory, naming the expression in place of a frequency.

**Status: `ENABLED` / `PAUSED` / `AUTO_PAUSED`.** `PAUSED` is what `update --pause` produces. `AUTO_PAUSED` means the platform disabled the schedule itself after repeated failures — currently 10 consecutive finished runs in which no test passed — reported as its own status precisely so it is not read as someone having paused it, and `schedule get` adds an `autoPaused:` timestamp line. `update --resume` re-enables either, and clears that failure streak.

**Past runs.** Inspect a schedule's execution history in the Portal. The former CLI history reader was removed without an alias; old invocations exit 5 as unknown commands.

**`update` sends only the flags you passed.** With no field, no `--pause` and no `--resume` it exits 5 (`nothing to update`) rather than issuing an empty request; `--pause` together with `--resume` is refused (exit 5) rather than silently resolved to one of them. `--send-to` replaces the recipient list rather than adding to it.

**`delete` requires `--confirm`** (exit 5 without it), matching every other destructive verb: it removes the schedule and its run history and stops it firing, with no restore window — recreating it starts a fresh schedule. `--dry-run` works without `--confirm`.

**Idempotency.** `create`, `update`, and `delete` each send an auto-minted `Idempotency-Key`, so a retried command cannot double-apply; `--idempotency-key <key>` sets it yourself (reuse the same key to retry safely). An auto-minted key is echoed to stderr under `--output json`, `--verbose`, or `--debug`.

**`schedule list` is not paginated.** It returns the full set, with no cursor flag, and takes `--columns <keys>` and `--no-header` for scripting. Every subcommand accepts the global `--output json|text` and `--dry-run`.

Exit codes on top of the [shared set](#exit-codes): **7** schedules are not available on this account, **13** not available on your plan (`create` also uses 13 when the plan limit is reached), **4** schedule — or, for `create`, the target — not found, **6** idempotency conflict. Every subcommand's `--help` embeds its own list.

### CI gate (`ci run`)

`ci run` runs a project's tests and waits for the verdicts with CI defaults. In a GitHub Actions pull request it tests **that pull request's preview deployment**. Set `PREVIEW_URL` to its deployed URL for the first example.

```bash
testsprite ci run --project "$PROJECT_ID" --env staging --target-url "$PREVIEW_URL"
testsprite ci run --project "$PROJECT_ID" --env staging                      # a fixed environment (nightly, shared dev)
testsprite ci run --project "$PROJECT_ID" --env staging --wait-for-status "Vercel" --target-url-template "https://app-git-{branch-slug}-team.vercel.app"
testsprite ci run --project "$PROJECT_ID" --filter checkout --fail-on-skipped
testsprite ci run --project "$PROJECT_ID" --summary-file testsprite-summary.json
```

`--project` defaults to `TESTSPRITE_PROJECT_ID`. All project tests are selected unless `--filter <substr>` narrows them (case-insensitive, non-empty substring); `--all` is optional. An explicitly empty `--filter` fails with `VALIDATION_ERROR` / exit **5** before any request, including with `--dry-run`; omit the flag to select every test. Whitespace is preserved. `--env <name>` names the environment whose sign-in the run uses; the name must be one of the project's environments (`testsprite project env list <id>`), and an unknown name is refused **before** anything dispatches or charges, even with `--allow-empty`. That check fails closed: an environment list that cannot be read is that error (a bad key exits **3**, a backend that is down **10**), never a run that goes on to dispatch unchecked; only a backend answering that the project has no environment surface (an older project, or an older backend without the route) leaves the name to the batch's own validation. `--target-url <url>` is a publicly reachable address to test, typically a pull request's preview deployment; `--skip-preflight` skips its reachability probe when the preview is still warming up. `ci run` refuses loopback targets, including a selected environment's stored loopback URL when no `--target-url` overrides it, with exit **5** and zero-valued step outputs. For a local app, use `testsprite run --project <project-id> --env <name> --wait` (see [`run`](#testsprite-run)). `--target-url-template <pattern>` is the same address written as a pattern and filled on the runner from the pull request — `{pr}`, `{pr-number}`, `{branch}`, `{branch-slug}`, `{sha}`, `{short-sha}`, the GitHub App's own placeholders, so a pattern copied from a Portal trigger renders the same URL (`https://app-git-{branch-slug}-team.vercel.app`; `{branch-slug}` is the branch lowercased with runs of anything else collapsed to `-`, as Vercel and Cloudflare Pages spell it). It replaces `--target-url` (passing both is refused), and a pattern this run cannot fill — `{pr}` outside a pull request — is refused with exit **5** naming the placeholder, never guessed. A placeholder in the host part must render to letters, digits and `-` (what `{branch-slug}`, `{pr}` and the sha placeholders always do); a raw `{branch}` whose value would change the host (`attacker.example/x`) is refused the same way, so the environment's sign-in is never sent to an address the pattern did not name. `--wait-for-status <name>` holds the run until the platform's own check on the head commit succeeds; see "When the platform posts only a commit status" below. In a pull request the run happens in a `github-pr-<N>` clone of `--env` at `--target-url`, so backend tests whose code uses `VAR_{url}` follow the preview too; outside one they use the environment's own URL — `--env`'s, or the project default's (see [`--target-url` with a project selection](#testsprite-run)).

**One execution per project gate.** The CLI submits the selected cases in one request. The server handles dispatch and later integration work. If the launch receipt does not confirm the requested settings, use the same [error fields as `run`](#testsprite-run) to inspect the execution. If `--wait-for-status` times out before launch, `error.details.reason` is `preview-status-timeout`.

**In a pull request.** Under GitHub Actions, `ci run` reads the pull request from the job: a `pull_request` event names it, and a `deployment_status` event (the platform-deploys-every-PR shape) only names the commit, so the PR is looked up with the job's `GITHUB_TOKEN` (`pull-requests: read`). With `--env X --target-url U`, the run then happens in a temporary clone of X pointed at U, named `github-pr-<N>` — the GitHub App's own mechanism, so the Portal shows `github-pr-<N>` as the run's environment, links the run back to the pull request ("View on Github"), and releases the environment when the run finishes. X must sign in with a username and password or not at all: a recorded (SSO) session cannot be cloned and is refused before anything is charged. A draft pull request, or a deployment that belongs to no open pull request, is skipped with a `::notice::` and exit **0** — there is nothing to gate; the step outputs are still written, as zeros, so a later step reading them gets a number. Outside a pull request (a push, a schedule, a shell), `--env X --target-url U` keeps `run`'s semantics: X's sign-in against U, recorded under X.

**When the platform posts only a commit status (shape C).** Some platforms create no GitHub deployment for a pull request — Vercel projects with the "deployment_status Events" toggle off, builds skipped by an Ignored Build Step, Cloudflare Pages — and leave only a commit status or check run on the head commit (`Vercel`, `netlify/<site>/deploy-preview`, `Cloudflare Pages`), whose link points at the platform's dashboard, not the site. A `pull_request` workflow then starts at the same moment the build does and has no event carrying the URL. `--wait-for-status <name>` polls both of GitHub's APIs for that name — `GET …/commits/{sha}/status` (`statuses[].context`) and `GET …/commits/{sha}/check-runs` (`check_runs[].name`), matched exactly, so which one the platform writes does not matter — backing off 5s → 30s for up to `--status-timeout` (default 900s; its own budget, not `--timeout`'s), with `GITHUB_TOKEN` (`statuses: read`, `checks: read`). Success → the run goes on; a failed, errored, skipped or cancelled check, or a success whose description says Ignored / Canceled / Skipped (Vercel's Ignored Build Step) → a `::notice::`, a one-line job summary ("no preview for this commit — tests not run"), zero step outputs and exit **0**. GitHub can show the step as successful, even though no tests ran and no `--summary-file` was written. Read the notice and the `total` step output to distinguish this skip from a completed gate. Still pending at the deadline → exit **7**, listing every status and check name seen on the commit so a misspelled name is obvious. `ci run` never falls back to the environment's URL or production. The name is whatever the pull request shows (`gh api repos/{o}/{r}/commits/{sha}/status --jq '.statuses[].context'`, `…/check-runs --jq '.check_runs[].name'`).

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  testsprite:
    runs-on: ubuntu-latest
    if: github.event.pull_request.head.repo.full_name == github.repository && !github.event.pull_request.draft && github.actor != 'dependabot[bot]'
    permissions: { contents: read, pull-requests: read, statuses: read, checks: read }
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: '22'
          package-manager-cache: false
      - run: npm install -g @testsprite/testsprite-cli
      - run: >-
          testsprite ci run --env default
          --wait-for-status "Vercel"
          --target-url-template "$PREVIEW_URL_TEMPLATE"
        env:
          TESTSPRITE_PROJECT_ID: ${{ vars.TESTSPRITE_PROJECT_ID }}
          TESTSPRITE_API_KEY: ${{ secrets.TESTSPRITE_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
          PREVIEW_URL_TEMPLATE: ${{ vars.PREVIEW_URL_TEMPLATE }}
```

Set the repository variable `TESTSPRITE_PROJECT_ID` to the project ID and the secret `TESTSPRITE_API_KEY` to its workspace key. For the status-based workflow, also set `PREVIEW_URL_TEMPLATE` to your platform's URL pattern (for example, `https://app-git-{branch-slug}-team.vercel.app`) and replace `Vercel` with the check name your platform posts.

**`ci run` does not filter deployments — the workflow does.** A `deployment_status` event fires for every state of every deployment (`pending`, `failure`, `success`, …) and for every environment (preview and production alike). `ci run` reads only the deployment's commit; it never looks at `state` or `environment`. A hand-written workflow therefore needs the job's `if:` to select the deployments worth gating, or a failed deployment is gated against a URL that never came up and a production deploy is gated like a preview:

```yaml
on: deployment_status
jobs:
  testsprite:
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: read }
    if: >-
      github.event.deployment_status.state == 'success' &&
      !github.event.deployment.production_environment &&
      github.event.deployment.environment != 'production'
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: '22'
          package-manager-cache: false
      - run: npm install -g @testsprite/testsprite-cli
      - run: testsprite ci run --env staging --target-url "$PREVIEW_URL"
        env:
          TESTSPRITE_PROJECT_ID: ${{ vars.TESTSPRITE_PROJECT_ID }}
          TESTSPRITE_API_KEY: ${{ secrets.TESTSPRITE_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
          PREVIEW_URL: ${{ github.event.deployment_status.environment_url }}
```

(Vercel marks its Production deployments with `production_environment: false`, so filter on the environment name, not on that flag.)

Failed or blocked tests exit **1**; a test that times out exits **7**. Tests skipped at dispatch, including incompatible in-flight tests, contribute to `skipped`. Later integration results belong to the execution and are included in the wait. They warn by default; `--fail-on-skipped` makes any skipped test fail the gate. Missing test ids always exit **4**. A batch where nothing dispatched exits **5**; `--allow-empty` accepts an empty selection (no tests, a filter that matched nothing, runs already in flight elsewhere) but never a batch the backend refused.

CI waits on owned executions and may join only explicitly verified matching held results. Incompatible held work remains skipped because it may target another deployment. `--timeout <seconds>` defaults to 600 (1–3600); `--max-concurrency <n>` sets the server execution dispatch limit (1–100). Idempotency keys are auto-minted; pass `--idempotency-key <key>` to control them.

The JSON envelope's `summary` and `--summary-file` use the same `CiSummary`: `{total, passed, failed, blocked?, cancelled?, errors?, skipped, timedOut, running?, results[]}`, one row per test with its `resultId` and `runId`. Without a report, the job summary is a `Run <run-id>` line and a results table (`Test | Status | Result`). On a backend that serves execution reports, `ci run` also fetches the **execution report** for the batch's run — the same content the GitHub App posts as its PR comment (verdict headline, AI narrative, per-test rows with error details, suggested fix prompts and screenshots, evaluation notes) — polling until it is ready for up to `--execution-report-timeout <seconds>` (default 60). When it arrives, the job summary is that report's Markdown instead of the results table, `summary.executionReport` carries the structured report, its run as `runId` (in the JSON envelope and `--summary-file`), and two step outputs name the files it was written to under `$RUNNER_TEMP`: `execution-report-file` (JSON) and `execution-report-markdown-file` (Markdown) — so a later step can `jq` the fix prompts or post the Markdown as a PR comment with its own token. When the CLI's own counts disagree with the report's (a run it could not read or that timed out, a test refused before dispatch, a retry error — things the run does not contain; a red run whose failures the report also shows agrees), the summary opens with a one-line **CI gate** warning stating the local counts and appends the rows the report cannot carry, so the summary never reads "all passed" under a red check. `--no-execution-report` keeps the job summary to the local results table and reads and writes nothing for the report. A run that timed out is not finished, so no report is read; otherwise the step can take up to `--timeout` plus `--execution-report-timeout`. Ctrl-C/SIGTERM while waiting for the report stops the wait: the finished batch's summary and outputs are still written with the local table, then the CLI exits with the signal's code (130/143). The two report files under `$RUNNER_TEMP` are written owner-only (`0600`). Screenshot URLs in the report are presigned public links. Note the audience: the job summary is readable by everyone who can read the repository (on a public repository, by anyone), whereas the App's PR comment only exists where the App is installed; the report's narrative, error details, fix prompts and screenshots are the same unredacted content in both places, so treat the summary as you would the PR comment. Without a report (an older backend, or not ready in time) the results table is written as before and nothing else changes. Under Actions, the job summary and annotations enable automatically; `--gh-output` forces them elsewhere. When `GITHUB_OUTPUT` is set, the numeric step outputs include `total`, `passed`, `failed`, `blocked`, `failedOnly`, `skipped` and `timedOut`. For compatibility, the Actions `failed` step output still includes blocked and cancelled results, read errors and failed executions without a corresponding adverse result. The `timedOut` step output includes execution-only timeouts. `failedOnly` and JSON `summary.failed` count failed test verdicts. Use the process exit code for a CI gate that also handles execution failures. Every output is written before the exit code is decided for a run that dispatched, for a skipped gate (draft pull request, no pull request) and when the command can report a partial execution; an unknown `--env` or a whole-batch API refusal exits before any output is written.

JUnit is opt-in: `--report junit --report-file results.xml` (optional `--report-suite-name`). It carries the same rows as the summary — every test that did not dispatch is a skipped `<testcase>` with its reason — so a partial batch can never read as a full one. Upload reports in a subsequent `if: always()` step. `--dry-run` previews dispatch without starting runs or writing result files (a credentialed dry run may read environment metadata). PR comments are not yet part of `ci run`.

### CI integration (`ci init`)

`ci init github` writes `.github/workflows/testsprite.yml`: a PR gate that runs the project's tests against **each pull request's preview deployment** with `testsprite ci run`. The workflow calls the CLI directly; `ci run` owns waiting, skipped counts, the PR context and the exit code, so the YAML only moves data. Everything `ci init` writes is fixed and snapshot-tested; the only part it cannot know is how your PR gets a preview, so that is one placeholder step you replace before committing.

```bash
# Scaffold — auto-detects your project if the key has exactly one
testsprite ci init github
testsprite ci init github --project "$PROJECT_ID"      # pin a specific project
testsprite ci init github --env staging                # sign in with this environment's settings
testsprite ci init github --timeout 1800               # how long ci run waits for a verdict
testsprite ci init github --dry-run                    # preview the file, write nothing
testsprite ci init github --force                      # overwrite an existing workflow

# Optional: set GITHUB_REPOSITORY to owner/name and authenticate gh to set the repo secret.
testsprite ci init github --set-secret --repo "$GITHUB_REPOSITORY"
```

**Replace the placeholder step.** The step marked `REPLACE ME` fails the job until you do. Pick the shape that matches how your PRs deploy:

- **A — your platform deploys every PR** (for example the Vercel or Netlify git integration): change the trigger to `on: deployment_status`, delete the placeholder step, and keep the rest. A repository that deploys **several** projects gets one deployment per project for the same commit (Vercel names them `Preview – <project>`); pin the one to gate with `&& github.event.deployment.environment == 'Preview – <project>'` in the `if:`, or the gate tests whichever project's URL arrives. The run step reads the URL from `github.event.deployment_status.environment_url`, and `ci run` finds the pull request behind the deployment's commit with `GITHUB_TOKEN`; a deployment that belongs to no open pull request is skipped with a notice. The job only runs for successful, non-production deployments (it checks both `production_environment` and the environment name, because Vercel reports `production_environment: false` on its production deployments). This shape needs the repository to actually receive deployment events from your platform; confirm it with one real pull request.
- **B — you deploy in the workflow**: keep `on: pull_request`, replace the placeholder's commands with your deploy, and end it with `echo "url=<preview address>" >> "$GITHUB_OUTPUT"`. Your platform token goes in its own repo secret.
- **C — your platform posts only a commit status or check** (no deployment event: Vercel with `deployment_status` events turned off, Cloudflare Pages): keep `on: pull_request`, delete the placeholder step, and in the `ci run` step replace the `PREVIEW_URL` env and the `--target-url "$PREVIEW_URL"` line with `--wait-for-status "<the check's name on the PR>" --target-url-template "<pattern>"` (the two flags cannot be combined with `--target-url`), then add `statuses: read` and `checks: read` under `permissions:`. The pattern is the preview address with the per-PR part as a placeholder (`https://app-git-{branch-slug}-team.vercel.app`, `https://{branch-slug}.app.pages.dev`, `https://deploy-preview-{pr}--site.netlify.app`); copy it from the platform's comment on a recent pull request. See "When the platform posts only a commit status" under `ci run`.

Concurrency groups include the workflow filename from `--path` so separate generated workflows do not cancel each other. The filename keeps its extension and URI-escapes special characters rather than discarding them; because GitHub compares group names case-insensitively, uppercase letters are escaped too, so `TestSprite.yml` and `testsprite.yml` stay separate. Regenerating the same file keeps its group; the PR number or deployment SHA still identifies runs within that workflow. Both examples below use `.github/workflows/testsprite.yml`.

The complete examples below read the project ID from the repository variable `TESTSPRITE_PROJECT_ID`. A workflow generated by `ci init` includes the selected project's ID directly.

```yaml
# A — the platform deploys every pull request (Vercel / Netlify git integration)
name: TestSprite
on:
  deployment_status:
permissions:
  contents: read
  pull-requests: read
jobs:
  testsprite-tests:
    concurrency:
      group: testsprite-testsprite.yml-${{ github.event.pull_request.number || github.event.deployment.sha }}
      cancel-in-progress: true
    if: >-
      github.event_name == 'deployment_status' &&
      github.event.deployment_status.state == 'success' &&
      !github.event.deployment.production_environment &&
      github.event.deployment.environment != 'production'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      TESTSPRITE_PROJECT_ID: ${{ vars.TESTSPRITE_PROJECT_ID }}
      TESTSPRITE_API_KEY: ${{ secrets.TESTSPRITE_API_KEY }}
      GITHUB_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '22'
          package-manager-cache: false
      - run: npm i -g @testsprite/testsprite-cli@latest
      - name: Run TestSprite tests on this PR's preview
        env:
          PREVIEW_URL: ${{ github.event.deployment_status.environment_url }}
        run: >-
          testsprite ci run
          --project "$TESTSPRITE_PROJECT_ID"
          --env "default"
          --target-url "$PREVIEW_URL"
          --fail-on-skipped
          --summary-file testsprite-summary.json
      - name: Upload TestSprite report
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: testsprite-results
          path: testsprite-summary.json
          if-no-files-found: ignore
```

```yaml
# B — the workflow deploys the preview itself (Vercel CLI shown)
name: TestSprite
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: read
jobs:
  testsprite-tests:
    concurrency:
      group: testsprite-testsprite.yml-${{ github.event.pull_request.number || github.event.deployment.sha }}
      cancel-in-progress: true
    if: >-
      github.event_name == 'pull_request' &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.actor != 'dependabot[bot]' &&
      !github.event.pull_request.draft
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      TESTSPRITE_PROJECT_ID: ${{ vars.TESTSPRITE_PROJECT_ID }}
      TESTSPRITE_API_KEY: ${{ secrets.TESTSPRITE_API_KEY }}
      GITHUB_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '22'
          package-manager-cache: false
      - run: npm i -g @testsprite/testsprite-cli@latest
      - name: Get this PR's preview URL
        id: preview
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
        run: |
          url=$(npx vercel@59 deploy --token "$VERCEL_TOKEN" --yes)
          echo "url=$url" >> "$GITHUB_OUTPUT"
      - name: Run TestSprite tests on this PR's preview
        env:
          PREVIEW_URL: ${{ steps.preview.outputs.url || github.event.deployment_status.environment_url }}
        run: >-
          testsprite ci run
          --project "$TESTSPRITE_PROJECT_ID"
          --env "default"
          --target-url "$PREVIEW_URL"
          --fail-on-skipped
          --summary-file testsprite-summary.json
      - name: Upload TestSprite report
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: testsprite-results
          path: testsprite-summary.json
          if-no-files-found: ignore
```

The last step runs `testsprite ci run --project <id> --env <name> --target-url <preview>`. In a pull request, the run uses a temporary copy of that environment pointed at the preview (named `github-pr-<N>`, like GitHub App runs, and released when the run finishes), so the Portal shows which pull request it tested.

What the generated workflow fixes in place: it installs `@testsprite/testsprite-cli@latest`; it requests `contents: read` and `pull-requests: read`; it skips fork pull requests (they run without repository secrets), Dependabot pull requests (Dependabot secrets are not Actions secrets) and draft pull requests (it runs again on `ready_for_review`); it passes `--fail-on-skipped`, so a test that never ran fails the gate instead of warning; under shape B a new push to the pull request cancels the previous job; under shape A the concurrency group is **per commit** (Vercel sets the deployment's `ref` to the commit SHA, so there is no branch to key on) and a new push does not cancel the previous commit's job — either way, cancelling only stops that job's CLI; the TestSprite run it started keeps executing and reports in the Portal, and the new push starts its own run. The group is declared on the job, so deployment events the `if:` drops (`pending`, `inactive`, another project's deployment of the same commit) never cancel a running gate; and it uploads `ci run`'s summary file even when the job fails.

> **Forks and shape A.** A `deployment_status` event runs the workflow file **at the deployed commit**, with the repository's secrets, and the event does not say whether that commit came from a fork. The `if:` can skip fork pull requests on `pull_request` events, not on deployments. If your hosting platform deploys pull requests from forks, turn that off on the platform (Vercel: fork protection / require authorization for fork deployments), or a fork's edit of the workflow runs with your `TESTSPRITE_API_KEY`.

`--env` names the environment whose sign-in each pull-request run uses (list them with `testsprite project env list <project-id>`); an unknown name is refused. Without `--env`, the project's default environment is written into the workflow **by name**, so changing the default later never silently changes what the gate runs. Prefer an environment with test-account or no sign-in: a recorded (SSO/manual) session cannot follow a preview's address, so `ci init` warns when you pick one. `--timeout` is written into the `ci run` line only when you pass it. `--path` must be a `.yml` or `.yaml` file directly under `.github/workflows/` — GitHub never runs a workflow anywhere else, so other paths are refused. If another workflow in that directory already mentions TestSprite, `ci init` warns that each pull request may run (and be billed for) its tests twice; it does not block. An existing file with the same content is left alone; different content needs `--force`, which overwrites it and keeps the previous file as `<path>.bak` — the preview step is hand-edited, so re-apply that edit after regenerating (the output names the backup).

The API key comes from a `TESTSPRITE_API_KEY` repo secret; `ci init` prints the exact `gh secret set TESTSPRITE_API_KEY` command to add it, and `--set-secret` runs it for you when the [`gh` CLI](https://cli.github.com) is installed and authenticated (the key is passed on stdin, never the process list), degrading to the printed instruction otherwise — it never fails the scaffold. `--project` is optional only when the key owns exactly one project; with zero or several, pass it explicitly (a validation error names the fix). The endpoint is resolved from your profile (or `--endpoint-url`); a non-production endpoint is written into the workflow as `TESTSPRITE_API_URL`, and if it is a loopback/private address a GitHub-hosted runner can't reach, `ci init` warns (it still writes the file — self-hosted runners are legitimate). Every run accepts the global `--output json|text` and `--dry-run`; `--dry-run` makes no network call and uses placeholders for anything it would look up.

In a GitHub pull request, pass both `--env` and `--target-url` to run in a temporary preview environment. Backend test code that reads `VAR_{url}` uses that environment’s preview URL. A hard-coded URL keeps its original destination. See [Preview targets](#testsprite-run).

> To block merges on the gate, make the `testsprite-tests` check a required status check in your branch protection. The job is named `testsprite-tests` rather than `test` or `e2e` because GitHub matches required status checks by job name alone, across every workflow in the repository, so the name must not collide with a job you already have.

#### Checking that deployment events reach the repo

A workflow triggered by deployments (`on: deployment_status`) only fires if the repo actually **receives** GitHub Deployment events — written by whatever deploys your app (Vercel's GitHub App writes them when the project is git-linked). When the platform is not linked, nothing is written and the gate stays silent, with no error anywhere. Set `GITHUB_REPOSITORY` to the repository in `owner/name` form and read its deployment history with an authenticated GitHub CLI.

```bash
gh api "repos/$GITHUB_REPOSITORY/deployments" --jq '.[] | "\(.environment) \(.ref[0:8]) \(.created_at)"'
```

Judge preview and production records separately — a PR gate keys on preview deployments, so production-only means "enable preview deploys on the platform". A newest preview months old is stale. If `gh` is missing or unauthenticated, that is "could not check", not "not linked". History is evidence, not configuration: no records can mean "linked but not deployed yet", and old records can mean "unlinked since" — the proof is one real pull request. To link a Vercel project, use the Vercel dashboard (project → Settings → Git) or Vercel's own CLI, `npx vercel link --project <name> --non-interactive` then `npx vercel git connect --non-interactive` (never `--yes`; `vercel link` writes `.env.local` and may edit `.gitignore`). Linking only affects future pushes, so push a commit on a branch afterwards and check for a new preview record. The `testsprite-ci` agent skill (`testsprite agent install`) walks a coding agent through exactly this.

**Self-hosted pipeline?** You don't need any of this — report each deploy to GitHub with its commit SHA (`SHA`) and deployed URL (`PREVIEW_URL`). Authenticate the GitHub CLI with deployment write access to `GITHUB_REPOSITORY`.

```bash
ID=$(printf '{"ref":"%s","environment":"preview","auto_merge":false,"required_contexts":[]}' "$SHA" \
  | gh api "repos/$GITHUB_REPOSITORY/deployments" --input - --jq .id)
gh api "repos/$GITHUB_REPOSITORY/deployments/$ID/statuses" -f state=success -f environment_url="$PREVIEW_URL"
```

`required_contexts: []` is not optional in practice: without it GitHub refuses to create the deployment with a `409 Conflict` whenever any commit status on that SHA is failing — which, on a PR whose checks are still red, is exactly when your pipeline is deploying a preview. The JSON-input form is used because `gh api -f` sends everything as a string, and an empty array has to stay an array.

### Account & diagnostics

#### `testsprite usage` (alias: `testsprite credits`)

Account pre-flight before a large batch: resolves the active key to its identity (`userId`, `keyId`, `env`) and shows its organization wallet (plan, balance, seats, and workspace state) when the backend supplies it. Useful right before a `run --project <project-id>` fan-out. For an org-scoped key, also prints the `orgs:` / `org binding:` lines described under [Authenticate](#1-authenticate).

```bash
testsprite usage --output json
testsprite credits
testsprite usage --dry-run --output json
```

#### `testsprite doctor`

One-shot environment diagnostic. Runs a fixed checklist — CLI version, Node.js runtime, active profile, API endpoint, credentials, live connectivity + key validity (`GET /me`), whether the verify skill is installed in the current project, whether the project is inside a Git repository (`Git repository`), and whether `.testsprite/` is ignored by a `.gitignore` between the project directory and the repository root (`Gitignore safety`) — and prints an OK/WARN/FAIL report. Exits non-zero only when a check **fails** (warnings, e.g. skill not installed or `.testsprite/` not ignored, don't fail the process; outside a Git repository both Git checks are informational), so it can gate a CI step or an agent preflight:

```bash
testsprite doctor
testsprite doctor --output json
testsprite doctor && testsprite run "$TEST_ID" --wait
```

Every check reuses the same helpers the real commands use, so the report reflects exactly what a subsequent command would resolve. For an org-scoped key, the report also lists `Organizations` (account-wide membership list) and `Org binding` (this key's bound organization) checks.

#### `testsprite auth remove`

Delete the active profile's stored credentials on this machine (`--profile <name>` for another). The API key is not revoked, and `TESTSPRITE_API_KEY` still authenticates.

#### `testsprite completion [bash|zsh|fish]`

Print a shell completion script (shell auto-detected from `$SHELL`), for example `eval "$(testsprite completion bash)"`.

## Configuration

### Profiles & credentials

Credentials live at `~/.testsprite/credentials` (INI-style, mode `0600`) — one section per profile. A credentials file resaved as UTF-16 (Windows PowerShell 5.1 `>` / `Out-File`, or Notepad's "Unicode") is still read, and the next save writes it back as UTF-8. **Profile resolution order** (highest first): `--profile` flag → `TESTSPRITE_PROFILE` env → `default`. Within a profile, the `TESTSPRITE_API_KEY` / `TESTSPRITE_API_URL` env vars override the file, so CI can run without ever touching `~/.testsprite/credentials`.

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
| `--dry-run`                   | Preview without remote writes or charges; configured `run` may read tunnel metadata             |

### Secrets in output

Authenticated API requests follow redirects only within the configured origin
(scheme, hostname and port). A cross-origin redirect is rejected before sending
credentials to its destination. The CLI reports both origins as a transport
error without retrying that request. Same-origin redirects retain normal HTTP
method/body behavior and are limited to 20 hops.

Any field named like `password`, `token`, `secret`, `apiKey` / `api_key`, `authorization`, `cookie`, or `credential(s)` — at any depth, inside arrays too — is replaced with `[REDACTED]` in an error envelope's `details` and in `--debug` request tracing, in both `--output json` and text. `--dry-run` previews never contain a secret in the first place: they show presence flags (such as `hasCredentials`) and field names, not credential values. This is a second, independent layer: the backend already redacts its own error envelopes, but the CLI redacts again on the way out. Ordinary fields that merely contain one of those words as a substring — a boolean presence flag like `hasCredentials`, a file path like `credentialsPath`, or a pagination cursor like `nextToken` — are left alone; only the credential-shaped field itself is blanked.

**Success output is never redacted by the CLI.** A command's result — plans, backend-test output and fixtures — is the caller's own data: it prints exactly as the server stored it, even when it legitimately contains a literal `Authorization: Bearer …` header or a `password` key. Redaction only ever touches error envelopes and request traces, never a success payload.

`project env create/update` also reject conflicting credential flags before a `--dry-run` plan.

### Environment variables

| Variable                                   | Purpose                                                                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TESTSPRITE_API_KEY`                       | API key - overrides the credentials file                                                                                                                                      |
| `TESTSPRITE_API_URL`                       | API endpoint - overrides the credentials file                                                                                                                                 |
| `TESTSPRITE_PROFILE`                       | Active profile (below `--profile`, above `default`)                                                                                                                           |
| `TESTSPRITE_PROJECT_ID`                    | Default project for `test list`, `run` without named IDs or a list, and the agent commands when `--project` is omitted                                                        |
| `TESTSPRITE_REQUEST_TIMEOUT_MS`            | Per-request timeout in **milliseconds** (default `120000`, range `1000`-`600000`)                                                                                             |
| `TESTSPRITE_NO_UPDATE_NOTIFIER`            | Any non-empty value disables the once-per-24h "new version available" notice                                                                                                  |
| `NO_COLOR`                                 | Suppress ANSI escape sequences in ticker output ([no-color.org](https://no-color.org/))                                                                                       |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`  | Standard proxy support - API traffic is routed through the configured proxy                                                                                                   |
| `TESTSPRITE_NO_SKILL_WARNING`              | Any value except blank, `0`, `false`, or `no` (after trimming and ignoring case) silences the "verify skill not installed" reminder (CI / manual use)                         |
| `TESTSPRITE_NO_TELEMETRY` / `DO_NOT_TRACK` | Any truthy value (not `0`/`false`/empty) disables usage telemetry (see Telemetry below)                                                                                       |
| `TESTSPRITE_PORTAL_URL`                    | Override the Portal origin used for `dashboardUrl` links (non-prod environments)                                                                                              |
| `TESTSPRITE_CLIENT`                        | Identifies a wrapper driving the CLI (`<name>/<version>`, e.g. `github-action/v1`); appended to the User-Agent and reported as telemetry `client`. Invalid values are ignored |

### Telemetry

Authenticated runs send one best-effort "command outcome" event per invocation
to TestSprite (`POST /api/cli/v1/telemetry`) so we can measure which commands
run and diagnose failures. Each event carries only:

- the command name (e.g. `run`), the outcome (`success`/`error`),
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
- for `run --project <project-id>`, `run --testlist <list-id>` and `run <id> --wait`: outcome
  **counts** only — `accepted`, `conflicts`, `deferred`, `skipped`, and the
  verdicts `passed` / `failed` / `blocked` / `timedOut` (disjoint; `failed`
  excludes blocked runs) — plus `conflictReason`, the most frequent reason a
  case did not dispatch (`in_flight`, `insufficient_credits`, `billing_hold`,
  `mcp_view_only`, `local_address`, `tunnel-required`, `error`);
- `local=true` for an explicit `--local` invocation (including borrowed/refused runs and project creation) or an automatically opened tunnel; tunnel runs also record `localConcurrencyLimit`, the requested per-execution dispatch limit; no client-observed peak is recorded;
- for `ci init`: `platform`, whether `--force` was passed, whether a workflow
  file already existed at the target path (`workflowExisted`), and whether the
  project came from `--project` or auto-detection (`projectResolved`);
- for `ci run`: `ciRunOutcome` — what the gate did (`gated`; `skipped_draft` /
  `skipped_no_pr` / `skipped_no_preview` when there was nothing to gate — the last when
  `--wait-for-status` learned the preview was never built; `timeout_preview` when it saw
  nothing terminal in time; `refused_url_template` when `--target-url-template` could not
  be filled; `refused_admission` /
  `refused_env` / `refused_preview_name` / `refused_loopback` / `refused_billing` /
  `refused_other` when it was refused before or at dispatch; `empty` when nothing was selected),
  the run's id (an internal event property, named `executionId`): the server's UUID for the
  run a gated test belongs to, so the event can be joined to that run's execution report
  (never a URL), and
  `reportReady` — whether the execution report reached the job summary or the
  local table was written instead.

It **never** sends: your API key, target URLs, free-form flag or argument values, test or
run ids (other than the `ci run` run id above — the server's own UUID, which names nothing about you or your code), repository names, or error **messages**. The event is a fixed
allowlist; timeout seconds and the local concurrency limit are bounded numeric controls. It is bounded to ~1s and fully best-effort — it never delays beyond that,
never changes a command's behavior or exit code, and is skipped entirely when no
API key is configured, under `--dry-run`, or when the command is interrupted (Ctrl-C / SIGTERM / SIGHUP).

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
`::warning title=TestSprite::` annotation instead — a workflow that pins an
old CLI keeps running it until the pin is updated (`ci init` workflows install
`@latest`); the annotation fires only when the running version has fallen below
the backend floor, never merely behind the newest npm release (the registry
check is skipped in CI). A
backend may also reject a too-old client outright with HTTP 426 - surfaced as
`CLIENT_TOO_OLD`, exit `14`, non-retriable, with upgrade guidance.

### Scopes

API-key scopes gate the write and run surfaces:

| Scope            | Required by                                                             |
| ---------------- | ----------------------------------------------------------------------- |
| `read:me`        | `auth status`, `usage`, `doctor` (connectivity check)                   |
| `read:projects`  | `project list / get`, `project env list / get`                          |
| `read:tests`     | every `test *` read command, `result list / get`, `run wait`, `status`  |
| `write:tests`    | the project's agent: `plan / reply / apply / reject / stop / discard`   |
| `write:projects` | `project create / update / delete`, `project env` writes                |
| `run:tests`      | `run` / `run cancel` (cancel also needs `read:tests`)                   |
| `run:tunnel`     | frontend runs that open a tunnel, `tunnel start / list / status / stop` |

Schedules use `read:schedules` for list/get and `write:schedules` for changes. Check the active key and workspace with `testsprite auth status`. Backend v0.18.0 or later grants `run:tunnel` to existing keys unless deliberately narrowed; older backends may require a new key. If a command returns `AUTH_FORBIDDEN`, the missing scope is named in `details.requiredScope` — regenerate your key from the dashboard to pick up new scopes.

## Output & scripting

For a single project on a hosted environment, capture the launch receipt and resume the same execution. This example requires `jq` and a shell with `PROJECT_ID` set. Save the script in its own file so the final `exit` returns the verdict to your caller.

```bash
#!/usr/bin/env bash
set -eu
receipt=$(testsprite run --project "$PROJECT_ID" --no-wait --output json)
run_id=$(jq -er '.runs[0].runId' <<<"$receipt")

wait_status=0
testsprite run wait "$run_id" --timeout 600 --output json > wait.json || wait_status=$?
if [ "$wait_status" -eq 1 ]; then
  jq -r '.results[]? | select(.status == "failed" or .status == "blocked") | .resultId' wait.json |
    while IFS= read -r result_id; do
      testsprite result get "$result_id" --out ".testsprite/results/$result_id" ||
        echo "Evidence incomplete for $result_id" >&2
    done
fi
exit "$wait_status"
```

A launch receipt can precede the first result. Read `results[]` after waiting. A cancelled execution or an execution-level failure can produce a nonzero exit even when no test row failed. Inspect `runFailures` when present. To list a test's previous outcomes, use `result list --test "$TEST_ID"`. Its `results[].testStatus` uses upper-case values such as `FAILED`. Reading a result succeeds even when that test failed.

## Continuous integration

Run TestSprite as a required check in any CI system: install the CLI, authenticate from the environment, run your tests to a verdict, and let the **exit code** gate the pipeline. JSON output and the [exit-code table](#exit-codes) are the stable automation contract, so nothing here depends on parsing human-readable text.

### GitHub Actions (fastest)

Set `ENV_NAME` to a saved environment from `testsprite project env list "$PROJECT_ID"` and scaffold a PR gate for that project:

```bash
testsprite ci init github --project "$PROJECT_ID" --env "$ENV_NAME"
```

This writes `.github/workflows/testsprite.yml`, which installs the CLI and runs `testsprite ci run` against the pull request's preview. Replace its one placeholder step with where your preview URL comes from (your platform's deployment event, or a deploy step in the workflow). See [CI integration (`ci init`)](#ci-integration-ci-init) for both shapes, every flag and the repo-secret setup.

### Any CI (generic recipe)

Configure `TESTSPRITE_API_KEY` as a masked CI secret and set `PROJECT_ID` to the project's ID. Add `TESTSPRITE_API_URL` only for a custom endpoint.

```bash
npm install -g @testsprite/testsprite-cli
testsprite ci run --project "$PROJECT_ID" \
  --summary-file testsprite-summary.json
```

- **Waiting is automatic.** The command follows every accepted test to a terminal verdict (or `--timeout`, default 600 s). Skipped tests warn by default; add `--fail-on-skipped` for a strict gate.
- **`--report junit --report-file <path>`** optionally writes a JUnit XML sidecar. Skipped tests appear as `<skipped>` testcases with their reasons; the unified summary includes them.
- **`--summary-file <path>`** writes a compact machine summary (`{ total, passed, failed, blocked?, cancelled?, errors?, skipped, timedOut, results[] }`, each row with its `resultId` and `runId`) you can read from any step — `blocked` counts blocked tests separately when present; tests that never dispatched (deferred / conflicted / not found / skipped) count under `skipped`. **`--gh-output`** additionally emits a job-summary table and annotations (`::error::` for failures/timeouts, `::warning::` for never-dispatched tests); it auto-enables under `GITHUB_ACTIONS=true`, so you rarely pass it by hand.
- If the wait ends while tests are still running, the summary includes a separate `running` count. The JUnit report marks those cases as skipped with an explanation, and GitHub Actions emits error annotations only for observed failures or timeouts.

Archive any requested reports with a step that also runs after failure (`if: always()` in GitHub Actions).

### Gate a curated test list

Use `ci run` for one project's tests. A saved test list lets you gate a selected set of cases across several projects and pin each project's environment.

```bash
testsprite run --testlist "$LIST_ID" --wait \
  --report junit --report-file testsprite-junit.xml
```

A test list is the addressable unit for a mixed FE/BE, multi-project CI gate; each project runs against its configured environment. See [Test lists (`testlist`)](#test-lists-testlist).

### Gating on the outcome

For `ci run`, the exit code **is** the gate:

| Exit              | CI meaning                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`               | accepted tests passed, an empty run was explicitly allowed, or the gate was skipped before dispatch (for example, because there was no preview). `--fail-on-skipped` applies to tests skipped at dispatch.                                 |
| `1`               | at least one test failed or was blocked, or `--fail-on-skipped` rejected skipped tests                                                                                                                                                     |
| `4`               | a requested test id was not found                                                                                                                                                                                                          |
| `7`               | The run or preview wait timed out, or the server could not confirm the requested settings. See [CI gate](#ci-gate-ci-run).                                                                                                                 |
| `5`               | the invocation dispatched **zero** tests (empty project, or a `--filter` that matched nothing). This is deliberate — a gate that greens on zero tests is worse than no gate. Pass `--allow-empty` when an empty run is genuinely expected. |
| `3` / `12` / `13` | auth / out-of-credits / paid-feature-gated — a config problem, not a test failure                                                                                                                                                          |

The full list is the [exit-code table](#exit-codes). For a run that dispatches, use `--output json` to read the run summary, or inspect the error envelope if the command fails. A gate skipped before dispatch emits a notice and zero-valued GitHub step outputs, with no run summary.

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

### Ambiguous org id (exit 6)

For a membership-scoped API key, a testId can — pathologically — resolve to
projects in more than one of your organizations. The CLI prints one
`candidate: project <id> (org <id>)` line per colliding project plus a hint
to re-run with `--project <id>`, and exits `6` (same family as a generic
conflict; retrying does not resolve it). `--output json` carries the same
information in `error.details.candidates`.

### Signals & pipes

During an **ordinary or adopted-tunnel** `--wait`, SIGINT (Ctrl-C), SIGTERM, or SIGHUP gracefully detaches: the in-flight request aborts, stdout receives a partial run result, and stderr names the signal and offers `run wait <run-id>` / `run cancel <run-id>`. The run keeps executing and remains billable; an adopted tunnel stays with its owner. This is distinct from observing that owner disappear, which cancels the borrower's own run by default. Exit codes are `128 + signal` (130 / 143 / 129).

For an **owned `--local` run**, the first signal instead cancels the non-terminal run by default and closes the tunnel. The CLI reports the cancellation outcome. For a frontend test cancelled before a terminal verdict the server attempts a refund; read the reported `refund`. `--no-cancel-on-interrupt` opts out of cancellation and detaches, but the owned tunnel still closes; the same flag also skips an adopted run's owner-gone cancellation. Use a new `run <test-id> --env <name>` to verify again; `run wait` cannot reopen it. See [local ownership and timeout rules](#local-frontend-testing-and-tunnels).

A second signal exits immediately unless a tunnel credential delete or run cancel is in flight; then the CLI waits up to 2 seconds for critical cleanup. A third signal always exits immediately. Outside a `--wait`, signals keep their immediate-exit behavior, except Ctrl-C on `tunnel start`, which is its normal exit 0. Closing the stdout pipe early suppresses the broken-pipe message. Outside an active wait the CLI retains the command’s own exit code.

## Design principles

1. **Resource-oriented.** Verbs (`list`, `get`) operate on resources (`project`, `test`, `run`, `result`).
2. **Scriptable.** Every command supports `--output json` for machine-readable output.
3. **Stateless.** No local database; the TestSprite backend is the source of truth.
4. **Composable.** Output is pipe-friendly and pairs well with `jq`.
5. **Agent-safe.** A `resultId` names one test's part of one run, so a read never mixes in another run's result.
