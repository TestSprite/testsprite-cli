<!--
  User-facing content for `testsprite agent install` (skill: testsprite-onboard).
  Body only — name + description frontmatter is emitted by the install wrapper.
  The cursor (.mdc), cline (.clinerules), and antigravity (experimental)
  wrappers reuse this body verbatim and swap only the frontmatter/header.
-->

# TestSprite: onboard a repo with a seed test suite

Your job is to take a repo that has **no TestSprite tests yet** and leave it with a
**coherent, runnable suite** plus a couple of **already-green** smoke tests — in one pass.
A new user who can immediately run a real, passing test is an activated user; an empty
project is the #1 drop-off.

This skill only uses shipped CLI commands. It works the same whether the user is on the V2
or V3 backend — the CLI routes internally. Do **not** call backend APIs directly.

## When to use

- Right after `testsprite setup`, or any time the active project has 0–1 tests.
- The user says "set up tests", "bootstrap", "seed a suite", "get me started", or similar.

## When NOT to use

- The project already has tests — that's the `testsprite-verify` skill's job, not this one.
- The user only changed code and wants it checked — again, `testsprite-verify`.

## Prerequisites

`testsprite setup` has run (an API key is configured). If `testsprite project list` errors on
auth, stop and tell the user to run `testsprite setup` first — don't try to configure for them.

## Steps

### 1. Understand the app (don't skip — this is where coverage quality comes from)

Read the repo to establish, concretely:

- **Frontend**: the deployed/local **URL**, the 4–8 most important user flows (auth, core
  CRUD, checkout, search, settings…), and whether flows need **login**.
- **Backend**: the key **API endpoints** and their success/error contracts.

Prefer **code-derived** routes/handlers over guessing — you have the source; use it. This
beats a blind crawl.

### 2. Create the project (FE must have a URL)

Frontend:

```bash
testsprite project create --type frontend --name "<repo name>" --url <app-url> \
  [--username <user> --password-file <path-to-secret>]
```

Backend:

```bash
testsprite project create --type backend --name "<repo name>"
```

Capture the returned `projectId`.

> **Critical for FE**: a frontend test with no resolvable target URL fails immediately with
> `No environment URL configured` — the suite goes all-red. Always pass `--url`. If flows need
> login, pass `--username/--password-file` now so authenticated pages are reachable.

### 3. Author the tests (quality over quantity)

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

**Backend auth — read the injected `__AUTH_HEADERS__`, NEVER hardcode any credential.** This
covers **every** secret the API needs — Bearer/JWT tokens **and** API keys (`sk-…`,
`x-api-key`), basic-auth blobs, cookies. TestSprite prepends a managed credential block
(`__AUTH_CREDENTIAL__` / `__AUTH_TYPE__` / `__AUTH_HEADERS__`) to every backend test from the
project's Authentication settings, and `__AUTH_HEADERS__` already holds the right header(s) for
the configured type (Bearer → `{"Authorization": "Bearer …"}`; API key → `{"X-API-Key": "…"}`;
basic → `{"Authorization": "Basic …"}`). Spread it into your request headers — never paste a
literal `Bearer …` / `sk-…` / key value into the script:

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

**Assertion rule (this is the whole game for FE):** every `assertion` step must name a
**concrete, observable** outcome — an element, text, URL, count, or status. Never write
`"verify it works"`, `"check the page loads"`, or other narrative that an AI judge can
rubber-stamp. Vague assertions are how false-PASS sneaks in.

Aim for ~8–15 tests covering the core flows. Don't pad.

### 4. Batch-create

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
testsprite test run <testId> --wait
```

Do **not** run the whole suite automatically — a 20-test FE suite is ~40 credits and a free
account only has 150. Running the full suite is the user's explicit choice.

### 6. Report

Tell the user, plainly:

- "Your project now has **N** tests covering: <list the flows>."
- "I smoke-ran **M** — here's the result: <pass/fail + the dashboard link from the run output>."
- "To run the rest (≈X credits — state the cost so they choose knowingly):
  - frontend — run each remaining test by id: `testsprite test run <testId> --wait` (there is
    **no `--all` for frontend**);
  - backend — `testsprite test run --all --project <id>` (wave-ordered, runs every BE test)."

## Quality checklist (self-check before reporting done)

- [ ] FE project has a real `--url`; login configured if the app needs it.
- [ ] Every FE assertion names a concrete, observable outcome (no "verify it works").
- [ ] Tests cover the core flows you found in the code, not just one page.
- [ ] Smoke-ran 2–3 happy-path tests, not the whole suite.
- [ ] Reported test count, smoke result + dashboard link, and the cost to run the rest.

## Don'ts

- Don't auto-run the full suite (credit wall / surprise 402).
- Don't write narrative assertions an AI judge can't fail.
- Don't call backend endpoints directly — only the `testsprite` CLI.
- Don't create a FE project without a URL.
- Don't re-seed a project that already has tests — that's not this skill's job.

## Hand off to verify

This skill's job ends once the project has a seeded suite and a first green run. From here on,
the **`testsprite-verify`** skill takes over: after the user changes code, it runs the tests
covering that change before they report the work done. Onboard once; verify continuously.
