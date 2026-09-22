<!--
  User-facing content for `testsprite agent install` (skill: testsprite-onboard).
  Body only — name + description frontmatter is emitted by the install wrapper.
  The cursor (.mdc), cline (.clinerules), and antigravity (experimental)
  wrappers reuse this body verbatim and swap only the frontmatter/header.
-->

# TestSprite: onboard a repo with a seed test suite

Seed a repo with no tests into a coherent suite and 2–3 passing smoke tests.

This skill only uses shipped CLI commands. Do **not** call backend APIs directly.

For deployed targets, try generation first (V3 required), then author by hand.
Local projects use authored plans directly; exploration is unavailable.

## When to use

- Right after `testsprite setup`, or any time the active project has 0–1 tests.
- The user says "set up tests", "bootstrap", "seed a suite", "get me started", or similar.

## When NOT to use

- The project already has tests — that's the `testsprite-verify` skill's job, not this one.
- The user only changed code and wants it checked — again, `testsprite-verify`.

## Prerequisites

`testsprite setup` has run (an API key is configured). If `testsprite project list` errors on
auth, stop and tell the user to run `testsprite setup` first — don't try to configure for them.
In a sandbox, `testsprite setup --from-env` can use `TESTSPRITE_API_KEY` even when HOME
is read-only: credential-write permission failures warn and continue session-only.
The JSON summary has `credentials.persisted: false`; export the key in every invoking
shell. Agent installation still needs a writable target; `--no-agent` skips it.

## Steps

### 1. Understand the app

Read the source to identify:

- **Frontend**: the deployed/local **URL**, the 4–8 most important user flows (auth, core
  CRUD, checkout, search, settings…), and whether flows need **login**.
- **Backend**: the key **API endpoints** and their success/error contracts.

Use code-derived routes/handlers; do not guess.

### 2. Create the project

Deployed frontend:

```bash
testsprite project create --type frontend --name "<repo name>" --url <app-url> \
  [--username <user> --password-file <path-to-secret>]
```

Local frontend (start the app first; V3 required):

```bash
testsprite project create --type frontend --name "<repo name>" --local <port> --local-host <host>
```

`--local` stores `http://<host>:<port>`; `--local-host` sets both probe and URL host:
`localhost`, `127.0.0.1` (default), or `::1` (`http://[::1]:<port>`).
Reuse the host on runs; omit for default IPv4.
`project get/list`: JSON `originMode: 'local'`, text `(Local)`.
No `--url`. Dead port: exit 5 (`--skip-preflight` bypasses).
V2-only: exit 7 (`local-origin-requires-v3`). Local runs work on Free and need
`run:tunnel` (mint a new key if missing).

Backend:

```bash
testsprite project create --type backend --name "<repo name>"
```

Capture the returned `projectId`.

For frontend, configure login with
`--username/--password-file` if needed; the cloud agent logs in through the tunnel
using the project environment's username/password. OTP environments are refused
before charge (exit 6).

#### 2b. FE: register the app's test-hook attribute

If the source tags elements with something other than `data-testid` (e.g. `data-element`),
run `testsprite project update <projectId> --test-id-attributes data-element,data-testid`
once; exported locators then use the tag (check: `project get` → `testIdAttrs:`).

### 3. Get the tests

**Local project: go directly to 3b.** Creation does no exploration/generation;
`test plan generate` is refused before charge (exit 6). Author a plan, then use:

```bash
testsprite test create --plan-from plan.json --project <projectId>
testsprite test run <testId> --local <port> --local-host <host>
```

Portal runs are blocked for free until `project update <id> --url https://…` sets
a public URL. For deployed projects, try 3a first.

#### 3a. Preferred: generate → review → accept

Proposals stage on the server for review; no files are written locally.

API projects require an API spec (`no_processed_inputs` without one). An optional
PRD supplements it (`--role prd`, 0.5 credits); a PRD alone can charge strategy and
then fail for missing endpoints. Deployed frontend exploration supplies its inputs.

```bash
testsprite project docs upload ./openapi.yaml --project <projectId> --role api-doc
testsprite project docs upload ./prd.md --project <projectId> --role prd   # optional, with the spec
```

```bash
testsprite test plan generate --project <projectId>
```

Only missing stages run. Frontend exploration can take minutes; Ctrl-C detaches
while generation continues. If inputs are still processing, wait and re-run.

Review titles and steps against the source. Drop nonexistent flows, duplicates,
and vague assertions before accepting.

```bash
testsprite test plan accept --project <projectId>                       # all of them
testsprite test plan accept --project <projectId> --only prop_2 prop_5  # or a subset
```

A subset accept **discards the rest**, so name every proposal you want in that one call.
Then `testsprite test list --project <projectId>` for the ids, and go to step 5
(**skip step 4** — that's the hand-authoring path).

If generation is unavailable (older CLI, non-V3 account/exit 6, or missing inputs),
report the reason and author tests using 3b. Local-project creation itself still
requires V3.

#### 3b. Author the tests by hand

**Frontend** — one JSON plan file per flow, in a directory (e.g. `./testsprite-plans/`).
Each file is a COMPLETE plan and must include `projectId` (from step 2), `type: "frontend"`,
`name`, and `planSteps` — `create-batch` reads the project from each file, not from a flag:

```json
{
  "projectId": "<projectId from step 2>",
  "type": "frontend",
  "name": "Checkout — guest can complete a purchase",
  "planSteps": [
    { "type": "action", "description": "Navigate to /products and open the first product" },
    { "type": "action", "description": "Click 'Add to cart', then go to /cart" },
    {
      "type": "assertion",
      "description": "The cart shows exactly 1 line item with the product's name and price"
    },
    { "type": "action", "description": "Proceed to checkout as guest and submit the test payment" },
    { "type": "assertion", "description": "A confirmation page appears showing an order number" }
  ]
}
```

**Backend** — one `.py` file per endpoint, using `requests` with concrete assertions on
status code and response body.

**Backend auth:** read injected `__AUTH_HEADERS__`; never hardcode Bearer/JWT tokens,
API keys, basic-auth blobs, or cookies. TestSprite injects `__AUTH_CREDENTIAL__`,
`__AUTH_TYPE__`, and `__AUTH_HEADERS__` from project Authentication settings.
The headers already match the configured type (Authorization for Bearer/basic,
X-API-Key for API keys). Spread them into each request:

```python
r = requests.get(f"{TARGET_URL}/orders", headers={**__AUTH_HEADERS__})
```

Configure the credential once on the project (ask the user for the value — never invent it or
reuse a key you happened to see): a static credential with
`testsprite project credential <projectId> --type "Bearer token"|"API key"|"basic token" --credential <value>`,
or an auto-refreshing login with `testsprite project auto-auth <projectId> …` so scheduled/repeat
runs keep working after the token expires. A hardcoded token expires within hours and a hardcoded
key can't be rotated centrally — `test create` emits a `[warn]` on an inlined credential; treat it
as a must-fix.

Each assertion must name an observable element, text, URL, count, or status.
Avoid "verify it works" or "check the page loads": vague assertions create false passes.

Aim for ~8–15 tests covering the core flows. Don't pad.

### 4. Batch-create (hand-authored path only — skip if you accepted generated proposals)

Frontend (one call, up to 50 plans from the directory — `create-batch` is FE-only and has
**no `--project` flag**; the project comes from each plan file's `projectId`):

```bash
testsprite test create-batch --plan-from-dir ./testsprite-plans
```

Backend (one call per file — `create-batch` is FE-only; `--name` is required):

```bash
testsprite test create --type backend --name "<behavior being tested>" \
  --code-file ./tests/<endpoint>.py --project <projectId>
```

Capture the created `testId`s from the output.

### 5. Smoke-run a few — NOT all (protect credits)

Pick the **2–3 highest-value happy-path** tests (prefer ones you're most confident are green)
and run only those:

```bash
testsprite test run <testId> --wait                     # deployed target
testsprite test run <testId> --local <port> --local-host <host>  # local frontend
```

Do **not** run the whole suite automatically. V3 frontend runs, including local runs,
cost 0.5 credit each; check `testsprite usage` before sizing the suite.
Local runs imply waiting (1200 seconds by default); one test per invocation, parallel
invocations allowed, 5 live tunnel bindings per user. Keep the early stderr `Run <runId>`
receipt. An owned local timeout cancels by default: start a new run with
`--local <port> --local-host <host> --timeout 1800` (same host), not `test wait`. A run cancelled before it finished is refunded.

### 6. Report

Tell the user, plainly:

- "Your project now has **N** tests covering: <list the flows>."
- "I smoke-ran **M** — here's the result: <pass/fail + the dashboard link from the run output>."
- "To run the rest (≈X credits — state the cost so they choose knowingly):
  - frontend — use `test run <testId> --wait` for deployed targets or
    `test run <testId> --local <port> --local-host <host>` for local targets (`--all --local` is refused);
  - backend — `testsprite test run --all --project <id>` (wave-ordered, runs every BE test)."

## Quality checklist (self-check before reporting done)

- [ ] FE project has a public `--url` or uses `--local`; login configured if needed.
- [ ] API project: an API spec uploaded before generating (a PRD is optional, alongside it) — or you used path 3b.
- [ ] If you generated: you **read the proposals** and dropped the ones that don't fit,
      rather than accepting the batch unseen.
- [ ] Every FE assertion names a concrete, observable outcome (no "verify it works").
- [ ] Tests cover the core flows you found in the code, not just one page.
- [ ] Smoke-ran 2–3 happy-path tests, not the whole suite.
- [ ] Reported test count, smoke result + dashboard link, and the cost to run the rest.

## Don'ts

- Don't auto-run the full suite (credit wall / surprise 402).
- Don't write narrative assertions an AI judge can't fail.
- Don't call backend endpoints directly — only the `testsprite` CLI.
- Don't create a FE project without public `--url` or `--local <port>`.
- Don't re-seed a project that already has tests — that's not this skill's job.
- Don't accept a generated batch unread — reviewing it is the point of the staging step.
- Don't stall when generation isn't available — say so and hand-author instead.
- Don't re-run `test plan generate` hoping for a different batch: with proposals already
  staged it starts nothing, and regenerating is a Portal action today.

## Hand off to verify

After seeding and a first green run, hand off to `testsprite-verify` for subsequent changes.
