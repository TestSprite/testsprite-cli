---
name: testsprite-verify
description: TestSprite verification loop — after finishing a feature or fix in a TestSprite-tested repo, use the `testsprite` CLI to run the relevant TestSprite tests against the change and inspect any failure artifacts before reporting the work as done. Use whenever code has changed outside docs/config and is about to be reported complete — by running an existing test that covers the change, or by asking the project's agent for a new one (`testsprite plan`, then `testsprite apply`) and running it to a terminal verdict.
---

<!--
  User-facing content for `testsprite agent install`.
  The cursor (.mdc), cline (.clinerules), and antigravity (experimental)
  wrappers reuse the body below verbatim and swap only the frontmatter/header.
-->

# TestSprite Verification Loop

The verification loop that flies your just-shipped feature through the
TestSprite CLI and reports back.

You just finished a piece of work in a TestSprite-tested repo. Before you report
it done, **actually run the relevant TestSprite test(s)** through the `testsprite`
CLI and read the result. Spec review and unit tests catch correctness; only
running the test catches what breaks for a real user.

## When to run

Run after a feature or fix lands — one feature → one test run, at the moment it
lands, not batched at the end. You don't write or edit TestSprite tests yourself:
the project's agent does (`testsprite plan` → `testsprite apply`), and what it
saves accumulates into the project's suite. Before asking for a new test, check
`testsprite test list` for an existing one that already covers the behavior.

The CLI tests either a **deployed** URL or a frontend test running on this
machine — it doesn't build or host your environment either way. For a deployed
change, wait until it's live somewhere reachable (e.g. open the PR, let CI
deploy the preview/staging environment). Create a named environment for its
public URL once, then select it with `--env <name>` on runs. Running earlier
verifies the previous build, not your change.

For a change that is only running locally, don't wait for a deployment: run
`testsprite run <test-id> --local <port>` instead. It tunnels this
machine's own loopback address (`localhost` / `127.0.0.1` / `::1` — not a LAN
or RFC1918 address, and not a general local-network escape hatch) to the test
runner. It is for frontend tests only (a backend test reaches its API over HTTP from
the runner, so run it normally against a deployed environment). Existing API keys work for local runs; no replacement key is
needed. `--local <port>` selects or creates the
project's `local-<port>` environment. With `--env <name> --local <port>`, that
named environment must also be local (`project env list <projectId>` shows names).

If the user explicitly named a tool (the CLI or the MCP), honor that choice
regardless of which one the change's reachability would otherwise suggest.

## When to skip

The skip list is narrow:

- Docs-only edits (`docs/**`, `*.md`, comments).
- Pure build/config edits (`tsconfig*`, lint/prettier config, lockfile bumps with
  no behavior change).
- Credentials are unavailable. Explain the missing setup; do not claim a
  verified result. If credentials exist but a local project is missing, use
  the bootstrap below.

Otherwise, run it.

## The one-test minimum

Every shipped feature gets **at least one** TestSprite run to a terminal verdict
(`passed` / `failed` / `blocked` / `inconclusive`) before you call it done. What
counts:

- `testsprite run --project <projectId> --wait` for the project suite, **or**
- `testsprite run <id> --wait` against an existing test, **or**
- `testsprite run <id...> --wait` on the tests `testsprite apply` just
  saved, with at least one returning a terminal verdict.

What does **not** count: unit tests / typecheck / lint; a plan the agent
proposed but nobody ran; asking the user to run it for you.

If the project has **no tests at all**, that's the `testsprite-onboard` skill's
job, not this one — seed a suite first with the project's agent (`testsprite plan`
→ `testsprite apply`). Seeding is a deliberate setup pass, not part of the verify loop.

If you can't satisfy this — no creds, no valid target URL, repo not linked —
**say so explicitly**: "Feature shipped but I could not run any TestSprite test
because <X>. Treat this as unverified until that's resolved." Don't claim done.

## 1. Preflight

```bash
testsprite --version              # CLI installed?
testsprite auth status            # credentials configured?
```

- `--version` fails → the CLI isn't installed. Tell the user to install the
  TestSprite CLI (see the TestSprite docs) and stop; don't install it for them.
- `auth status` fails → no credentials. Tell the user they can run
  `testsprite setup`, then stop.

## 2. Find the project

In priority order:

1. `$TESTSPRITE_PROJECT_ID` if set.
2. `.testsprite/config.json` in the repo root, if it has a `projectId`.
3. `testsprite project list --output json` → match a project whose `name` looks
   like this repo (e.g. a `Portal` repo → the `Portal` project).
4. Still ambiguous → list the candidates and ask the user which to use (one short
   question; picking the wrong project wastes a run).

If no project exists for an app running only locally, bootstrap a frontend project,
ask the agent for tests, and run the ids `apply` saved:

```bash
testsprite project create --type frontend --name "<repo name>"
testsprite project env create <projectId> --name local --local <port>
testsprite plan "<what you built>" --diff --project <projectId> --output json
testsprite apply --output json
testsprite run <id> <id> --local <port> --local-host <host> --output json
```

Keep the app listening and use the same `--local-host` for creation and follow-up
runs. It selects both the probe and stored URL host: `localhost`, `127.0.0.1`
(default), or `::1`; omit it in both commands to use the default.
The port probe fails with exit 5 if nothing listens (`--skip-preflight`
bypasses it). The agent's browser can't open an app on this machine, so it works
from your change (`--diff`) and the project's other environments.
The Portal shows local environments without a Run action. Create a public
environment for deployed apps and select it with `--env <name>`.

## 3. Decide what to test

Look at the diff (`git diff --stat`, then the changed files) to understand what
user-facing behavior changed. Pick one sub-mode. For a brand-new feature the
right default is almost always (b); (a) is for tweaks to behavior an existing
test already covers; (c) is for a test that is itself wrong.

### (a) An existing test covers the change

```bash
testsprite test list --project <projectId> --output json   # the cases, as they are written
```

Heuristic: a change to `src/components/CheckoutForm.tsx` is more likely covered
by "Checkout happy path" than "Login flow." Frontend change → `type: frontend`;
backend → `type: backend`.

### (b) A new test for the change (most common)

**Ask the project's agent.** It is the agent the user has in the TestSprite
portal: it explores the app in a real browser (frontend) or calls the API
(backend), reads your change, and writes the tests against what the app is
supposed to do. You review its plan and apply it; you don't write the tests
yourself, so they don't share your blind spots.

```bash
testsprite plan "<what you built, and the rules the user gave for it>" --diff \
  [--file <prd-ticket-or-api-spec>] --project <projectId> --output json
# "state": "proposed" → show the user the plan, then:
testsprite apply                      # or: apply --exclude <ref>; reject "<what to change>"
# "proposal.kind": "question" → show the user its questions and options, then answer by letter:
testsprite apply --answer 1=b --answer 2=a,c   # or your own words: --answer 1="…"
testsprite run <test-id...> --wait --output json   # the ids apply saved, in "applied.tests"
```

- Put the rules the user told you in the request. Don't invent expectations: a
  test whose description says its expectation is only what the app does today is
  the user's call, so ask them before you apply it.
- For distinct paths (happy + error + edge), ask for them in the same request;
  2–5 tests, more only with the user's confirmation.
- `"state": "replied"` → read `reply`. Answer from the code what you can with
  `testsprite reply "..."`; ask the user only what only they know.
- Exit 7: the agent is still working; `testsprite status --wait` follows it.
  Exit 13: the agent isn't enabled for this account; tell the user and stop —
  the CLI has no other way to write tests.
- For an app only on this machine, the agent works from your change and the
  project's other environments; run what it saved with `--local <port>`.
- When you open the pull request, put `prSummary` from the `apply` output in its
  description, so reviewers see the tests that now guard the change.

**Review the plan before you apply it.** A loose plan produces a
confidently-wrong `passed` or a thrashing `blocked`. Reject (`testsprite reject
"<what to change>"`) a test that:

- asserts only that something is visible — presence ≠ working (an `<img>` whose
  `src` 404s still "renders"); the assertion must say the thing works and is correct;
- for a visual / layout feature, asserts content only — at least one assertion
  should name geometry or position (side-by-side, stacked, above/below, grid);
- names no specific page region for its assertion, or a fuzzy target ("open a thing");
- depends on state outside the test's control: third-party auth (OAuth/SSO/2FA),
  OS-native surfaces (file upload/download, native dialogs), multi-tab or iframes.

**Backend credentials.** The agent's backend tests read the project's injected
credential (`__AUTH_HEADERS__`); they never hardcode a token. Configure it **once on
the project's environment** (ask the user for the value — never invent or reuse a key
you happened to see):

- **Bearer / API key / basic (static):**
  `testsprite project env update <projectId> <env> --auth bearer|basic|apikey --credential-file <path>`
  (extra headers: `--header "Name: value"`, secret ones in `--header-file <path>`)
- **Auto-refreshing login (recurring token):**
  `testsprite project env update <projectId> <env> --auto-auth-file <path>` (format: `project env update --help`)

### (c) A test that is wrong

You don't edit tests. If a test fails because the test itself is wrong (stale
steps, a wrong expectation), tell the agent and apply its fix:

```bash
testsprite plan "the <test name> test should <correct behavior>: <why>" --project <projectId>
testsprite apply
```

Drifted steps are healed during a run; a wrong expectation needs the agent.

## 4. Run

For a deployed target, create its environment once, then use `--env <name>`
after that deployment contains the change. Omit `--env` for Default; an unknown
name fails with available names and never falls back. For a local change,
use `testsprite run <test-id> --local <port>` (frontend only); it implies
waiting and defaults to 1200 seconds.

```bash
# One-time setup for a deployed target
testsprite project env create <projectId> --name staging --url https://staging.example.com

# Run the project suite and wait
testsprite run --project <projectId> --env staging --wait --timeout 600 --output json

# (a) existing test
testsprite run <test-id> --env staging --wait --timeout 600 --output json

# (a-several) several tests in one batch; --skip-dependencies (BE) runs only the named tests
testsprite run <test-id> <test-id> --env staging --wait --timeout 600 --output json
testsprite run <test-id> --skip-dependencies --wait --timeout 600

# (b) the tests `apply` saved
testsprite run <test-id> <test-id> --env staging --wait --timeout 600 --output json

# Narrow a project selection by title
testsprite run --project <projectId> --filter <name-substr> --wait --timeout 600   # subset by name
```

Saved lists retain their pinned project/environment mappings:

```bash
testsprite run --testlist <listId> --wait --output json
testsprite run <test-id> <test-id> --testlist <listId> --wait --output json
# Resume or cancel whole executions; these IDs are runId, not testId/resultId
testsprite run wait <run-id...> --timeout 600 --output json
testsprite run cancel <run-id...> --output json
```

Choose a project, named tests, or a saved list. `--project` cannot combine with
positional IDs or `--testlist`; named IDs and list selection ignore
`TESTSPRITE_PROJECT_ID`. Without IDs or a list, that variable supplies the default
project. Lists reject environment/target overrides and use positional members
for subsets. `--filter` narrows only project selection. Use `run wait R --timeout
600` with lifecycle flags after the child; launch flags before a child are errors.

Key behaviors:

- Environment `--url` takes a public http/https URL or a loopback http origin
  with an explicit port (frontend only); private and link-local addresses are
  refused. Running against a loopback environment opens a tunnel automatically
  and waits, like `--local <port>`. `--env <name> --local <port>` sends that
  environment's sign-in to your local app; the server applies it or refuses
  before dispatch.
- `--wait` reads execution status until terminal and handles its own backoff — don't wrap it
  in a retry loop.
- `--local` implies `--wait`, with a default timeout of 1200 seconds per test (ordinary
  waits default to 600). Run several local frontend tests in ONE command (`run <id> <id> … --local <port>`) instead of starting one process per test. `run --project <id> --local <port>` runs frontend tests and reports backend tests as skipped. They start one run per project (up to 5000 named test IDs per request) through one tunnel; `--max-concurrency` sets the server dispatch limit per execution, default 5 and maximum 15. Each execution is waited on independently; this limit never queues polling. There are
  5 live tunnel bindings per user; `tunnel_binding_limit` is exit 11 and is not
  auto-retried. Reuse a live tunnel with `--tunnel-client` or stop an unused one.
  On a tunnel-limit error, run `testsprite tunnel list`, then `testsprite tunnel stop <id>`
  or `testsprite tunnel stop --all --confirm` if every binding should be revoked.
- Keep the ids the run prints. A run is one launch (`runId`); each test in it has a
  result (`resultId`). A project or named launch prints `Run <run-id>` on **stderr** at
  once, and so does a saved list (`--testlist`) under `--wait`; the card on stdout lists
  each run (`Run <run-id>`) with its results and, when the server supplies one, a
  `Dashboard: <url>` line (that run's page in the Portal).
  Parse `runs[].runId`, `results[].resultId` and the outcome counts in `summary` for
  any selection or resumed wait. `partial: true` marks an incomplete timeout or
  interruption. A completed failure can be inspected immediately with `result get`.
- An **owned** local run requests cancellation by default when waiting stops (timeout,
  Ctrl-C, or a polling failure), then its tunnel closes. Read the reported
  cancellation outcome. For a frontend run cancelled before a terminal verdict,
  the backend attempts a refund. Inspect `refund.status`; cancellation does not
  guarantee a refund.
  `--no-cancel-on-interrupt` detaches instead, but the owned tunnel still closes.
  An adopted run normally detaches without cancellation and never closes the
  owner's tunnel. If the CLI confirms the owner has disappeared while the run is
  active, it requests cancellation by default; `--no-cancel-on-interrupt` skips
  that request.
  A second `tunnel start` or process using the same credential takes over, and the first exits **10**.
- Exit codes: `0` = passed; `1` = failed / blocked / cancelled; `7` = timeout
  or unsupported. An owned local timeout is inconclusive: start a **new**
  `testsprite run <test-id> --local <port> --timeout 1800`, keeping the same
  `--local-host <host>` if used; do not suggest `run wait` for that closed tunnel. Resume **ordinary or adopted-tunnel**
  waits with `testsprite run wait <run-id>` only while the target is reachable
  (and the adopted tunnel's owner remains alive).
- Exit `13` (`FEATURE_GATED`) and exit `12` (`INSUFFICIENT_CREDITS`) are not retriable: show the user the server's message and the link from `nextAction` or JSON `links`, then stop.
- A local environment has a loopback URL and needs `--local <port>` from that
  machine. A bare CLI run selecting it, explicitly or as Default, is refused
  before dispatch without charge (`tunnel-required`, exit 6). The Portal shows
  local environments but offers no Run; backend Portal requests are refused
  without charge. Schedules and test lists targeting them get a free BLOCKED
  result. A deployed environment selected with `--env <name>` or made Default
  runs normally even if the test ran through a tunnel before. Local runs use
  the agent path, never saved-code replay, and preserve the test's saved code.
- Run-trigger rate limit is 60/min/key, server-enforced; excess triggers return
  `RATE_LIMITED` (exit 11 for a single `run`).
- **Backend execution is dependency-aware; frontend is not.** `run
--project <id>` triggers a fresh batch over every test in the project: backend
  tests in wave order (producers → consumers → `teardown` last), frontend tests
  alongside. Check dispatch diagnostics and `summary.skipped` for tests that did not start. A big batch is accepted whole and its tests show `queued` until they
  start; `deferred` is rare (a project's lock stayed busy, or a test went in
  flight during dispatch) and is never resent (exit 7). A BE run expands the
  producer/teardown closure by default. Pass `--skip-dependencies` (`run <test-id> --skip-dependencies`)
  only when this round already verified the producers.
- Idempotency: the CLI auto-mints an `Idempotency-Key`; replays within 24h return
  the original run.

## 4a. Read the result — plan, or product?

Don't take the verdict at face value. After a run, read the result
(`testsprite result get <result-id> --output json`: `error`, `cause`, `fix`,
`failedStep` and every step; a backend test adds its traceback `trace` and its
output `apiOutput`) and ask: **plan quality, or actual product behavior?**

The plan is the problem (most common — check first) when:

- recorded action count < plan action count → steps the plan left ambiguous were
  skipped;
- assertions degraded to bare "Verify element is visible" with no subject;
- 5+ consecutive click attempts on similar targets with no progress.

The product/environment is the problem (believe these) when:

- `cause` / `error` names a concrete app observation ("the panel renders
  read-only", "page 404s");
- the trace blames infra (deploy lag, auth gate, missing fixture).

Read the result of the run you are verifying, by the `resultId` that run printed.
`testsprite result list --run <run-id> --status failed,blocked` lists what did not
pass in a run; `testsprite result list --test <test-id> --limit 5` lists a test's
recent results, newest first. A result of an earlier run is not evidence for this one.

**Read the testing agent's failure summary skeptically — it can conflate two
failure phases.** When a flow produces an artifact that then runs against an external
target, "the backend returned an error" may mean the action endpoint itself
failed (feature broken) **or** the action succeeded and the produced artifact
failed later at runtime (orthogonal to your feature). Cross-check the step trace
and runtime output: if the runtime output references a literal you submitted
earlier in the plan, the action succeeded and the error is runtime-phase.

**BE closure runs: root-cause the earliest failed wave, not the selected test.**
When `run` expanded a dependency closure and a **producer**
failed, every consumer downstream of it fails or blocks by starvation (missing
token / missing fixture). The selected test's red verdict does not implicate
your feature — report it as failed-downstream, read the producer's result
first, and only blame the consumer once its producers pass in the same run.

If it's the plan: tell the agent what is wrong with it (§3c), apply its fix and
re-run **once** (two runs total), then stop. Don't grind. If it's the product/env: report the verdict with the
testing agent's observation; don't auto-fix on the recommendation alone. If you
genuinely can't tell: report `inconclusive` with the signal that triggered the
call and ask.

## 5. On failure → download the evidence

```bash
testsprite result get <result-id> --out .testsprite/results/<result-id>
testsprite result get <result-id> --out .testsprite/results/<result-id> --failed-only  # failed step ±1
```

It writes `result.json` (the result, each link replaced by its file), the video and
each step's `steps/001.png` / `steps/001.html`. Give each result its own directory:
in an existing one, `result.json`, `video.*`, `steps/` and `sign-in/` are replaced.
Inspect the failed step and its neighbors, the video, `cause` and `fix` before
deciding whether your change caused it.

## 6. Report

When you tell the user the feature is done, include:

- Which test(s) you ran — one line each: id, name, verdict. At least one terminal
  verdict is required; zero means the feature is **not** done — surface that.
- The verdict. Don't report `passed` if §4a's sanity check tripped — surface as
  `inconclusive` with the specific signal.
- If the user wants to inspect a test or run themselves, point them at the
  dashboard link from the CLI output (`runs[].dashboardUrl` in JSON; a `Dashboard:` line
  under each run in text mode) — `run`, `run --wait` and `run wait` all carry one when
  the server supplies it (a saved list launched without `--wait` has none until
  `run wait`). It opens that run's page in the Portal.
- If failed, a one-line summary of the result's `cause` and `fix`. **Don't auto-fix** on that alone — the recommendation
  can be wrong; the human should look.
