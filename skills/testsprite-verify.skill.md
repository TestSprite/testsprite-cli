# TestSprite Verification Loop

The verification loop that flies your just-shipped feature through the
TestSprite CLI and reports back.

You just finished a piece of work in a TestSprite-tested repo. Before you report
it done, **actually run the relevant TestSprite test(s)** through the `testsprite`
CLI and read the result. Spec review and unit tests catch correctness; only
running the test catches what breaks for a real user.

## When to run

Run after a feature or fix lands — one feature → one test run, at the moment it
lands, not batched at the end. Tests you create this way accumulate into the
project's TestSprite suite; before writing a new one, check `testsprite test list`
for an existing test that already covers the behavior and extend it instead of
duplicating.

The CLI tests a **deployed** URL — it doesn't build or host your environment.
Run the loop only once the change is live somewhere reachable (e.g. open the PR,
let CI deploy the preview/staging environment) and pass that URL as
`--target-url`. Running earlier verifies the previous build, not your change.

## When to skip

The skip list is narrow:

- Docs-only edits (`docs/**`, `*.md`, comments).
- Pure build/config edits (`tsconfig*`, lint/prettier config, lockfile bumps with
  no behavior change).
- This repo isn't actually wired to TestSprite (no project linked, no creds).
  Don't pull the user into a setup flow they didn't ask for — say so and stop.

Otherwise, run it.

## The one-test minimum

Every shipped feature gets **at least one** TestSprite run to a terminal verdict
(`passed` / `failed` / `blocked` / `inconclusive`) before you call it done. What
counts:

- `testsprite test create … --run --wait` returning a terminal verdict, **or**
- `testsprite test run <id> --wait` against an existing test, **or**
- `testsprite test create-batch --plans plans.jsonl --run --wait` (or
  two-step: create-batch, then `test run <id> --wait`) on at least one
  test returning a terminal verdict.

What does **not** count: unit tests / typecheck / lint; drafting a plan without
`--run`; asking the user to run it for you.

If you can't satisfy this — no creds, no valid target URL, repo not linked —
**say so explicitly**: "Feature shipped but I could not run any TestSprite test
because <X>. Treat this as unverified until that's resolved." Don't claim done.

## 1. Preflight

```bash
testsprite --version              # CLI installed?
testsprite auth whoami            # credentials configured?
```

- `--version` fails → the CLI isn't installed. Tell the user to install the
  TestSprite CLI (see the TestSprite docs) and stop; don't install it for them.
- `auth whoami` fails → no credentials. Tell the user they can run
  `testsprite auth configure`, then stop.

## 2. Find the project

In priority order:

1. `$TESTSPRITE_PROJECT_ID` if set.
2. `.testsprite/config.json` in the repo root, if it has a `projectId`.
3. `testsprite project list --output json` → match a project whose `name` looks
   like this repo (e.g. a `Portal` repo → the `Portal` project).
4. Still ambiguous → list the candidates and ask the user which to use (one short
   question; picking the wrong project wastes a run).

## 3. Decide what to test

Look at the diff (`git diff --stat`, then the changed files) to understand what
user-facing behavior changed. Pick one sub-mode. For a brand-new feature the
right default is almost always (b) or (c); (a) is for tweaks to behavior an
existing test already covers.

### (a) An existing test covers the change

```bash
testsprite test list --project <projectId> --output json
testsprite test list --project <projectId> --status failed --output json   # what's already red
```

Heuristic: a change to `src/components/CheckoutForm.tsx` is more likely covered
by "Checkout happy path" than "Login flow." Frontend change → `type: frontend`;
backend → `type: backend`.

### (b) A new test for the change (most common)

**Frontend — draft a `plan.json`.** You name the behavior and list steps in plain
language; you don't write browser code.

```jsonc
{
  "projectId": "prj_abc",
  "type": "frontend",
  "name": "Booking date range change updates the estimated total",
  "description": "When a user opens a listing and extends the booking date range, the booking-panel estimated total updates to reflect the new dates before payment.",
  "priority": "p1",
  "planSteps": [
    { "type": "action", "description": "Navigate to the homepage" },
    { "type": "action", "description": "Search for stays with a valid destination and date range" },
    { "type": "action", "description": "Open a listing from the search results" },
    {
      "type": "action",
      "description": "Select an initial short date range to view the estimated total",
    },
    { "type": "action", "description": "Change the date range to a longer stay" },
    {
      "type": "assertion",
      "description": "Verify the estimated total on the booking panel updates from the initial value to reflect the new longer dates",
    },
  ],
}
```

- `name` — an assertable behavior statement (subject + verb + outcome), not a noun
  fragment — e.g. "Booking date range change updates the estimated total" tells
  the testing agent what to verify; "date range" tells it nothing.
- `description` — the condition + expected outcome in one sentence; disambiguates
  a short name.
- `priority` — `p0` (must-pass) / `p1` (important paths) / `p2` (edge) / `p3`
  (cosmetic). Pick honestly.
- `planSteps` — `Array<{ type: 'action' | 'assertion', description: string }>`,
  max 200 steps / 256 KB. Describe user intent, not selectors.

**Backend — write the Python yourself and use `--code-file`.** There is no
server-side codegen on the CLI. Read the API surface that changed (OpenAPI, the
route handler, request/response shapes) and write a pytest-style assertion script
to a tempfile. **End the file by calling your `test_*` function(s)** — the runner
executes the file top-to-bottom and does NOT auto-discover/collect test functions
the way `pytest` does, so a test that is only _defined_ (never called) silently
passes regardless of its assertions:

```python
# /tmp/login-empty-password.py — runs against the project's target URL, creds injected.
import requests

def test_login_rejects_empty_password():
    r = requests.post(f"{TARGET_URL}/login", json={"email": "a@b.c", "password": ""})
    assert r.status_code == 400
    assert r.json().get("error") == "invalid password"

# Required: actually invoke the test so its assertions run.
test_login_rejects_empty_password()
```

**Execution environment (backend).** The code runs in a locked-down sandbox with
only the Python **standard library + `requests` + `pytest` + `numpy` + `scipy`**
(plus `requests`' own deps like `urllib3`). So:

- **Test the API over HTTP** with `requests` against the target URL — that's what a
  backend test verifies.
- **Do NOT `import` the project's own source modules** (e.g. `from app.services import …`,
  `import core`, `import model`) or other third-party/ML packages (e.g. `torch`,
  `pandas`, `django`). They are not installed, so the test fails to even run.
- Get values from the API's responses (and captured variables), not by importing and
  calling the app's internals.

**Backend tests that share state declare dependencies at create time.** For a
one-off verification, prefer a single self-contained script (log in inside the
same file). But when the coverage set splits naturally into producer → consumer
→ cleanup — one test captures an auth token or created-resource id that others
reuse — declare the graph with the dependency flags instead of duplicating setup
in every file:

```bash
# producer — captures a variable for later waves
testsprite test create --type backend --project <projectId> --name "login issues an auth token" \
  --code-file /tmp/login.py --produces auth_token

# consumer — scheduled in a wave after every producer it names
testsprite test create --type backend --project <projectId> --name "profile update accepts the issued token" \
  --code-file /tmp/profile.py --needs auth_token

# cleanup — always scheduled in the final wave
testsprite test create --type backend --project <projectId> --name "fixture user is deleted" \
  --code-file /tmp/cleanup.py --category teardown
```

- `--produces <var>` / `--needs <var>` are repeatable. All three flags are
  **backend-only** — combined with `--type frontend` the CLI exits 5.
- **Don't hand-sequence `test run` calls to fake ordering.** The wave engine owns
  ordering: trigger the set with `test run --all` (§4) and producers run before
  consumers, `teardown` last. Chaining `run A --wait && run B --wait` yourself
  loses the engine's variable passing and conflicts with concurrent runs.
- **Declarations are currently create-only.** `test update` cannot amend them and
  `test get` / `test list` don't echo them back, so note what each test
  produces/needs as you create it; changing the graph later means delete +
  recreate.

**Show the user the drafted plan / code before creating it** — creating writes to
their project. One short confirmation; let them edit the tempfile first.

#### Authoring planSteps the testing agent will execute reliably

Execution reliability tracks plan wording. A loose plan produces a
confidently-wrong `passed` (bare visibility assertions) or a thrashing
`blocked`. Write to these rules first:

- **One verb per step.** `and` / `then` between two verbs → split — e.g.
  "Search for stays and open the first result" becomes two steps.
- **Describe outcomes, not selectors.** The testing agent locates targets
  semantically — describe the intent and the match stays robust across copy
  changes; a guessed literal label defeats that. E.g. write `"Submit the form"`,
  not `"Click the blue 'Submit' button"`.
- **`Navigate to` only on step 1** (or a login page). Use clicks for every later
  transition — direct URLs break SPA routing.
- **FE plans narrate a user journey through their actions.** Each action is
  what a real user does (click, type, navigate, hover, scroll), forming a
  sequence that exercises what gives the feature its value. The final assertion
  verifies what the journey produced — the state the user arrived at, a
  comparison against an earlier state, a derived count — not just that the
  starting page rendered.
- **Name the target entity type, not a fuzzy noun.** If a page has several
  look-alike row kinds, "open a thing" lets the testing agent pick the wrong
  kind. Name the type and the page/view you expect to land on.
- **1–2 assertions, at the end, on whether the content is present _and actually
  works_** (see _presence ≠ working_ below) rather than UI copy / formatting.
  (Quoting a literal you submitted earlier in the same plan, to verify it
  round-trips, is fine.)
- **Presence ≠ working.** A node can exist yet be broken or wrong — e.g. an
  `<img>` whose `src` 404s renders a broken-image box but still passes "element
  present / has alt." Assert the thing actually **works and is correct**, not
  just that the tag exists; trust the testing agent to judge correctness rather
  than hard-coding the expected answer into the assertion.
- **Assertion targets name the specific page region** (panel / tab / output area).
  Otherwise the testing agent settles for "some element with that text is
  visible anywhere," which passes for wrong reasons.
- **For visual / CSS / layout-sensitive features, content-presence-only
  assertions are dangerous.** "Verify the methodology section is visible" passes
  even when the stylesheet is missing and three cards render as flat unstyled
  text stacked vertically — the strings exist on the page, and a content-presence
  assertion constrains nothing about layout. For any feature whose value depends on
  layout, include at least one assertion that names geometry or relative
  position (row, column, side-by-side, stacked, grid, above/below, span, card
  background, border), not just content existence:

  ```jsonc
  // BEFORE — content-presence-only (passes even on broken CSS)
  { "type": "assertion", "description": "Verify the methodology section with three sub-score formulas is visible" }

  // AFTER — content + layout
  { "type": "assertion", "description": "Verify the methodology section shows three card cells laid out side-by-side in a single horizontal row, each with a distinct card background and a heading; the three cards together span the full content width" }
  ```

- **Keep `description` and `planSteps` in scope agreement** — the testing agent
  reads `description` as the test's purpose and shrinks execution to match. If
  you change the steps, re-align the description.
- **Keep flows that depend on state outside the test's control out of scope:**
  third-party auth (OAuth/SSO/2FA), OS-native surfaces (file upload/download,
  drag-and-drop, native dialogs), cross-context state (iframes, multi-tab,
  external services). Pick a different verification.
- **Test data must be self-contained** — create what you need within the plan, or
  don't write the plan.

### (c) A coverage set — multiple FE plans as a batch

When a FE feature has distinct paths (happy + error + edge), draft a
`plans.jsonl`, one spec per line. Aim for 2–5 plans; more only with explicit user
confirmation. Max 50 plans / 5 MB per batch.

```jsonc
// plans.jsonl — FE only
{"projectId":"prj_abc","type":"frontend","name":"login happy path","planSteps":[...]}
{"projectId":"prj_abc","type":"frontend","name":"login wrong password","planSteps":[...]}
{"projectId":"prj_abc","type":"frontend","name":"login empty email","planSteps":[...]}
```

Batch is **FE-only.** For 3 backend tests, run `test create --type backend
--project <projectId> --code-file <file>` three times with three Python files.

### (d) Refine an existing test

- **FE** — replace the steps, then re-run:
  ```bash
  testsprite test plan put <test-id> --steps refined.json
  ```
- **BE** — write updated Python and replace the code (optimistic concurrency):
  ```bash
  testsprite test code put <test-id> --code-file refined.py --expected-version <current-version>
  ```

## 4. Run

All variants use `--wait` for a synchronous verdict, `--target-url <env-url>` for
the deployment under test, and `--timeout 600` as a sane default.

```bash
# (a) existing test
testsprite test run <test-id> --target-url <env-url> --wait --timeout 600 --output json

# (a-rerun) cheap replay of an existing test. FE: replays the saved script (auto-heal on — more
# lenient than a fresh run; for strict verification of a new change prefer `test run`).
# BE: dispatches the WHOLE dependency closure — producers and teardowns run too, not just <test-id>,
# so expect their side effects (fixtures re-created, teardown deletes) and extra runs in history.
testsprite test rerun <test-id> --wait --timeout 600 --output json
testsprite test rerun <test-id> --skip-dependencies --wait --timeout 600   # BE: named test only

# (b-FE) new FE test from plan
testsprite test create --plan-from plan.json --run --wait --target-url <env-url> --timeout 600

# (b-BE) new BE test from Python (backend create needs --project)
testsprite test create --type backend --name "..." --project <projectId> --code-file foo.py --run --wait --target-url <env-url> --timeout 600

# (b-BE coverage set with dependencies) create each test without --run, then one wave-ordered batch
testsprite test run --all --project <projectId> --wait --timeout 600 --output json
testsprite test run --all --project <projectId> --filter <name-substr> --wait --timeout 600   # subset by name

# (c) FE coverage set — single-call create + run (FE-only)
testsprite test create-batch --plans plans.jsonl --run --wait \
  --target-url <env-url> --max-concurrency 3 --timeout 600 --output json
# Two-step alternative (inspect before running):
#   testsprite test create-batch --plans plans.jsonl --output json
#   then trigger each id: testsprite test run <test-id> --wait --target-url <env-url> --timeout 600

# (d-FE) refine + re-run
testsprite test plan put <test-id> --steps refined.json && \
testsprite test run <test-id> --target-url <env-url> --wait --timeout 600

# (d-BE) refine BE code + re-run. NOTE: if you reach for `test rerun` here instead, a BE rerun
# dispatches the full producer/teardown closure — use --skip-dependencies while iterating on one
# script (producers already verified this round), then finish with a closure run before reporting.
testsprite test code put <test-id> --code-file refined.py --expected-version <current-version> && \
testsprite test run <test-id> --target-url <env-url> --wait --timeout 600
```

Key behaviors:

- `--target-url` must be an allowed project/environment URL. The CLI rejects
  `localhost` / RFC1918 / link-local — local-only changes can't be run here. If
  the feature is deployed only locally, say so and skip the run.
- `--wait` long-polls until terminal and handles its own backoff — don't wrap it
  in a retry loop.
- Exit codes: `0` = passed; `1` = failed / blocked / cancelled; `7` = timeout.
  Treat `7` as inconclusive (resume with `testsprite test wait <run-id>`), not a
  regression.
- Batch: `create-batch --run --wait` creates the tests (FE-only) and fans
  out triggers in one call (bounded by `--max-concurrency`), emitting
  `{ results: [...] }` that mirrors the single-test `test run --wait`
  envelope. Exit `0` if every run passed; `1` for any failed/blocked/
  cancelled or trigger error; `7` only when EVERY run timed out. Drop
  `--run` if you want to inspect the created tests before triggering.
- Run-trigger rate limit is 60/min/key, server-enforced; the CLI self-throttles
  to 50/min. `--max-concurrency` (default 50) does NOT raise the server cap —
  excess triggers return `RATE_LIMITED` (per-spec in batch JSON; exit 11 for
  single `test run`). The test row stays created, the run never started. A full
  `create-batch` (≤50 specs) fires all at once under the cap. The 50/min throttle
  is per-invocation — separate batches/processes don't share it — so for >50 specs
  in a minute you lean on the server's 60/min cap + `RATE_LIMITED` retries, not
  client queuing. Re-list and check `draft` rows — "tests created" is
  not the same as "runs triggered".
- **Backend execution is dependency-aware; frontend is not.** `test run --all
--project <id>` triggers a fresh wave-ordered batch over the project's backend
  tests (producers → consumers → `teardown` last); FE tests in the project are
  skipped with an advisory, and everything not dispatched is enumerated
  (`conflicts` / `deferred` / `skippedFrontend`) so don't count `accepted[]`
  alone. `test rerun <be-id>` expands the producer/teardown closure by default —
  stderr summarizes `Reran N tests: 1 selected + P producer(s) + T teardown(s)`,
  and failed members surface as `closureFailures[]` without flipping the exit
  code. Pass `--skip-dependencies` only when this round already verified the
  producers and you're iterating fast on one script.
- `test code put` needs `--expected-version <codeVersion>`; stale etag → exit 6,
  re-fetch via `test get <id>` and retry. `--force` bypasses but is audit-logged.
- Idempotency: the CLI auto-mints an `Idempotency-Key`; replays within 24h return
  the original test/run.

## 4a. Read the result — plan, or product?

Don't take the verdict at face value. After a run, pull the steps
(`testsprite test steps <test-id> --output json`) and ask: **plan quality, or
actual product behavior?**

The plan is the problem (most common — check first) when:

- recorded action count < plan action count → steps the plan left ambiguous were
  skipped;
- assertions degraded to bare "Verify element is visible" with no subject;
- 5+ consecutive click attempts on similar targets with no progress.

The product/environment is the problem (believe these) when:

- `cause` / `error` names a concrete app observation ("the panel renders
  read-only", "page 404s");
- the trace blames infra (deploy lag, auth gate, missing fixture).

Scope step counts to the **current run** — `test steps` is cumulative across runs;
filter on the run-id before counting.

**Read the testing agent's failure summary skeptically — it can conflate two
failure phases.** When a flow produces an artifact that then runs against an external
target, "the backend returned an error" may mean the action endpoint itself
failed (feature broken) **or** the action succeeded and the produced artifact
failed later at runtime (orthogonal to your feature). Cross-check the step trace
and runtime output: if the runtime output references a literal you submitted
earlier in the plan, the action succeeded and the error is runtime-phase.

**BE closure runs: root-cause the earliest failed wave, not the selected test.**
When a rerun or `run --all` expanded a dependency closure and a **producer**
failed, every consumer downstream of it fails or blocks by starvation (missing
token / missing fixture). The selected test's red verdict does not implicate
your feature — report it as failed-downstream, pull the producer's artifact
first, and only blame the consumer once its producers pass in the same run.

If it's the plan: tighten via `test plan put` and re-run **once** (two runs total),
then stop. Don't grind. If it's the product/env: report the verdict with the
testing agent's observation; don't auto-fix on the recommendation alone. If you
genuinely can't tell: report `inconclusive` with the signal that triggered the
call and ask.

## 5. On failure → download the artifact

```bash
testsprite test artifact get <run-id> --out ./.testsprite/runs/<run-id>/
```

Inspect the failure bundle (result, failed step + neighbors, video, root-cause
hypothesis, recommended fix target) before deciding whether your change caused it.

## 6. Report

When you tell the user the feature is done, include:

- Which test(s) you ran — one line each: id, name, verdict. At least one terminal
  verdict is required; zero means the feature is **not** done — surface that.
- The verdict. Don't report `passed` if §4a's sanity check tripped — surface as
  `inconclusive` with the specific signal.
- If the user wants to inspect a test or run themselves, point them at the
  dashboard link from the CLI output (`dashboardUrl` in JSON; a `Dashboard:` line
  in text mode) — `test create` and `--wait` terminal output carry one.
- If failed, a one-line summary of the bundle's root-cause hypothesis and
  recommended fix target. **Don't auto-fix** on that alone — the recommendation
  can be wrong; the human should look.
