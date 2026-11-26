---
name: testsprite-onboard
description: Stand up a complete, runnable TestSprite test suite for the current repo at first use — create a project (with a target URL and auth), have the project's agent plan a coherent set of tests (`testsprite plan`, then `testsprite apply`), and smoke-run a few to a green verdict so the user has something worth running. Use ONLY when a repo has no TestSprite tests yet (a fresh project), right after `testsprite setup`, or when the user asks to "set up / bootstrap / seed tests". This is first-run setup, NOT change verification — once a project already has tests, use the testsprite-verify skill instead.
---

<!--
  Canonical reference for the `testsprite-onboard` skill installed by
  `testsprite agent install` / `testsprite setup`.

  The `description` in the frontmatter above is the SINGLE SOURCE OF TRUTH for
  the skill's auto-load description; a unit test asserts byte-identity between it
  and `SKILLS['testsprite-onboard'].description` in `src/lib/agent-targets.ts`.
  Edit BOTH together.

  The body below mirrors `skills/testsprite-onboard.skill.md` (the body-only
  asset that ships in the package); this doc is the human-readable reference with
  frontmatter attached.

  codex (managed-section / AGENTS.md) does NOT get this full body — it gets the
  one-line `ONBOARD_CODEX_LINE` from the registry, because AGENTS.md is always-on
  with a 32 KiB budget.
-->

# TestSprite: onboard a repo with a seed test suite

Seed a repo with no tests into a coherent suite and 2–3 passing smoke tests.

This skill only uses shipped CLI commands. Do **not** call backend APIs directly.

The tests are written by the project's agent (`testsprite plan` → `testsprite apply`);
you give it what it needs, review what it proposes, and smoke-run the result.

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

### 2. Create the project and its environment

```bash
testsprite project create --type frontend --name "<repo name>"   # or --type backend
```

Capture the returned `projectId`, then say where the app runs.

Deployed:

```bash
testsprite project env create <projectId> --name default --url <app-url> \
  [--username <user> --password-file <path-to-secret>]
```

Local frontend (start the app first):

```bash
testsprite project env create <projectId> --name local --url http://localhost:<port>
```

`--url` also takes `http://127.0.0.1:<port>` or `http://[::1]:<port>`, and the app's
entry path may follow (`--url http://localhost:<port>/app`); `--local <port>` is shorthand
for `--url http://localhost:<port>`. Dead port: exit 5 (`--skip-preflight` bypasses).
A backend project can't be local: its environment must point at a publicly deployed API.
Local runs work on Free and need `run:tunnel` (mint a new key if missing).

With a frontend test account, the cloud agent logs in through the tunnel using the
environment's username/password. OTP environments are refused before charge (exit 6).

Backend: configure the API credential once on its environment (ask the user for the value —
never invent it or reuse a key you happened to see). The agent's tests read it from the
injected `__AUTH_HEADERS__`; they never hardcode it. A static credential:
`testsprite project env update <projectId> <env> --auth bearer|basic|apikey --credential-file <f>`
(extra headers: `--header "Name: value"`, secret ones in `--header-file <f>`); a sign-in that
refreshes the credential: `--auto-auth-file <f>`.

#### 2b. FE: register the app's test-hook attribute

If the source tags elements with something other than `data-testid` (e.g. `data-element`),
run `testsprite project update <projectId> --test-id-attributes data-element,data-testid`
once; exported locators then use the tag (check: `project get` → `testIdAttrs:`).

### 3. Ask the project's agent for the tests

Name the flows from step 1 in the request, so the suite covers them rather than one page.
Attach what the agent can't see: an API spec (backend projects need one), a PRD, your
change.

```bash
testsprite plan "Seed a first suite: <the 4–8 flows from step 1>" --project <projectId> \
  [--file ./openapi.yaml] [--file ./prd.md] [--diff] --output json
```

- Frontend: the agent explores the app in a real browser. An app on this machine is reached
  through a tunnel: when the agent asks for one, run `testsprite tunnel start` in another
  terminal and `testsprite reply "The tunnel is running."`.
- `"state": "replied"` → read `reply`; answer from the code what you can with
  `testsprite reply "..."`, ask the user only what only they know.
- Exit 7: still working; `testsprite status --wait` follows it.
- Exit 13: the agent isn't enabled for this account. Tell the user and stop — the CLI
  has no other way to write tests.

`"state": "proposed"` → review the plan against the source before applying it:

- Drop flows that don't exist and duplicates.
- Every assertion names an observable element, text, URL, count, or status; vague
  ones like "verify it works" create false passes.
- Aim for ~8–15 tests covering the core flows. Don't pad.

```bash
testsprite apply                                   # all of it
testsprite apply --exclude <ref>,<ref>             # without some tests
testsprite apply --answer 1=b --answer 2=a,c       # a card that asks questions: answer by letter
testsprite reject "<what to change>"               # the agent revises and proposes again
```

`apply` prints the saved test ids (`applied.tests` in JSON).

### 4. Smoke-run a few — NOT all (protect credits)

Pick the **2–3 highest-value happy-path** tests (prefer ones you're most confident are green)
and run only those:

```bash
testsprite run <test-id> --wait                     # deployed target
testsprite run <test-id> --env local                # local frontend
```

Do **not** run the whole suite automatically. Frontend runs, including local runs,
cost 0.5 credit each; check `testsprite usage` before sizing the suite.
Local runs wait (1200 s each). Put several in ONE `run <id> <id> --env local`
(one tunnel, 5 at a time; each process holds 1 of 5 tunnel slots). Keep the stderr
`Run <run-id>` receipt. An owned local timeout cancels by default: start a new run with
`--env local --timeout 1800`, not `run wait`. For a frontend test cancelled before a terminal verdict the server attempts a refund; read the reported `refund`.

### 5. Report

Tell the user, plainly:

- "Your project now has **N** tests covering: <list the flows>."
- "I smoke-ran **M** — here's the result: <pass/fail + the dashboard link from the run output>."
- "To run the rest (≈X credits, so they choose knowingly):
  - frontend — use `run <test-id> --wait` for deployed targets or
    `run --project <id> --env local` for local targets;
  - backend — `testsprite run --project <id>` (wave-ordered, runs every BE test)."

## Quality checklist (self-check before reporting done)

- [ ] FE project has a public or local (`http://localhost:<port>`) `--url`; login configured if needed.
- [ ] API project: the API spec attached to the request (a PRD is optional, alongside it).
- [ ] You **read the plan** and rejected or excluded the tests that don't fit,
      rather than applying it unseen.
- [ ] Every FE assertion names a concrete, observable outcome (no "verify it works").
- [ ] Tests cover the core flows you found in the code, not just one page.
- [ ] Smoke-ran 2–3 happy-path tests, not the whole suite.
- [ ] Reported test count, smoke result + dashboard link, and the cost to run the rest.

## Don'ts

- Don't auto-run the full suite (credit wall / surprise 402).
- Don't apply narrative assertions an AI judge can't fail.
- Don't call backend endpoints directly — only the `testsprite` CLI.
- Don't create a FE project without a public or local (`http://localhost:<port>`) `--url`.
- Don't apply a plan unread — reviewing it is the point of the proposal.
- Don't write or edit tests yourself — ask the agent (`reply`, `reject`, or a new `plan`).

## Hand off to verify

After seeding and a first green run, hand off to `testsprite-verify` for subsequent changes.
