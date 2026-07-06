---
name: testsprite-verify
description: TestSprite verification loop — after finishing a feature or fix in a TestSprite-tested repo, use the `testsprite` CLI to run the relevant TestSprite tests against the change and inspect any failure artifacts before reporting the work as done. Use whenever code has changed outside docs/config and is about to be reported complete — by running an existing test that covers the change, or by creating a new TestSprite test (a frontend plan, or a backend Python assertion) and running it to a terminal verdict.
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
lands, not batched at the end. Tests you create this way accumulate into the
project's TestSprite suite; before writing a new one, check `testsprite test list`
for an existing test that already covers the behavior and extend it instead of
duplicating.

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
- `testsprite test create-batch --plans plans.jsonl` to create FE tests, then
  `testsprite test run <id> --wait` on at least one of them returning a terminal verdict.

What does **not** count: unit tests / typecheck / lint; drafting a plan without
`--run`; asking the user to run it for you.

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
  fragment. "Booking date range change updates the estimated total" tells the
  agent what to verify; "date range" tells it nothing.
- `description` — the condition + expected outcome in one sentence; disambiguates
  a short name.
- `priority` — `p0` (must-pass) / `p1` (important paths) / `p2` (edge) / `p3`
  (cosmetic). Pick honestly.
- `planSteps` — `Array<{ type: 'action' | 'assertion', description: string }>`,
  max 200 steps / 256 KB. Describe user intent, not selectors.

**Backend — write the Python yourself and use `--code-file`.** There is no
server-side codegen on the CLI. Read the API surface that changed (OpenAPI, the
route handler, request/response shapes) and write a pytest-style assertion script
to a tempfile:

```python
# /tmp/login-empty-password.py — runs against the project's target URL, creds injected.
import requests

def test_login_rejects_empty_password():
    r = requests.post(f"{TARGET_URL}/login", json={"email": "a@b.c", "password": ""})
    assert r.status_code == 400
    assert r.json().get("error") == "invalid password"
```

**Show the user the drafted plan / code before creating it** — creating writes to
their project. One short confirmation; let them edit the tempfile first.

#### Authoring planSteps the testing agent will execute reliably

Most "the agent looks broken" outcomes trace back to plan wording, not agent
bugs. A loose plan produces a confidently-wrong `passed` (bare visibility
assertions) or a thrashing `blocked`. Write to these rules first:

- **One verb per step.** `and` / `then` between two verbs → split.
- **Describe outcomes, not selectors.** Write `"Submit the form"`, not `"Click the
blue 'Submit' button"`. The agent does its own semantic match; a guessed label
  causes brittle exact-match thrash.
- **`Navigate to` only on step 1** (or a login page). Use clicks for every later
  transition — direct URLs break SPA routing.
- **Name the target entity type, not a fuzzy noun.** If a page has several
  look-alike row kinds, "open a thing" lets the agent pick the wrong kind. Name
  the type and the page/view you expect to land on.
- **1–2 assertions, at the end, on content existence** rather than UI copy /
  formatting. (Quoting a literal you submitted earlier in the same plan, to verify
  it round-trips, is fine.)
- **Assertion targets name the specific page region** (panel / tab / output area).
  Otherwise the agent settles for "some element with that text is visible
  anywhere," which passes for wrong reasons.
- **Keep `description` and `planSteps` in scope agreement** — the agent reads
  `description` as the test's purpose and shrinks execution to match. If you change
  the steps, re-align the description.
- **Skip flows the agent fails unpredictably on:** OAuth/SSO/2FA, file
  upload/download, drag-and-drop, iframes, native dialogs, multi-tab, external
  service state. Pick a different verification.
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

# (b-FE) new FE test from plan
testsprite test create --plan-from plan.json --run --wait --target-url <env-url> --timeout 600

# (b-BE) new BE test from Python (backend create needs --project)
testsprite test create --type backend --name "..." --project <projectId> --code-file foo.py --run --wait --target-url <env-url> --timeout 600

# (c) FE coverage set — create-batch only CREATES (FE-only); trigger each created test after
testsprite test create-batch --plans plans.jsonl --output json   # prints the created test ids
# then trigger each id: testsprite test run <test-id> --wait --target-url <env-url> --timeout 600

# (d-FE) refine + re-run
testsprite test plan put <test-id> --steps refined.json && \
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
- Batch: `create-batch` only creates the tests (FE-only) — it does not run them
  (`--run` is unsupported, exits 7). Trigger each created test with
  `test run <id> --wait` and read each verdict individually.
- `test code put` needs `--expected-version <codeVersion>`; stale etag → exit 6,
  re-fetch via `test get <id>` and retry. `--force` bypasses but is audit-logged.
- Idempotency: the CLI auto-mints an `Idempotency-Key`; replays within 24h return
  the original test/run.

## 4a. Read the result — plan, or product?

Don't take the verdict at face value. After a run, pull the steps
(`testsprite test steps <test-id> --output json`) and ask: **plan quality, or
actual product behavior?**

The plan is the problem (most common — check first) when:

- recorded action count < plan action count → the agent skipped steps it couldn't
  disambiguate;
- assertions degraded to bare "Verify element is visible" with no subject;
- 5+ consecutive click attempts on similar targets with no progress.

The product/environment is the problem (believe these) when:

- `cause` / `error` names a concrete app observation ("the panel renders
  read-only", "page 404s");
- the trace blames infra (deploy lag, auth gate, missing fixture).

Scope step counts to the **current run** — `test steps` is cumulative across runs;
filter on the run-id before counting.

If it's the plan: tighten via `test plan put` and re-run **once** (two runs total),
then stop. Don't grind. If it's the product/env: report the verdict with the
agent's observation; don't auto-fix on the recommendation alone. If you genuinely
can't tell: report `inconclusive` with the signal that triggered the call and ask.

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
- If failed, a one-line summary of the bundle's root-cause hypothesis and
  recommended fix target. **Don't auto-fix** on that alone — the recommendation
  can be wrong; the human should look.
