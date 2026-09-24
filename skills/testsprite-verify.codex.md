# TestSprite Verification Loop

After a feature/fix, run relevant tests and inspect failures before reporting done.
Skip docs-only/build-config edits. Missing credentials mean unverified.
Honor the user's explicit choice of CLI or MCP.

## 1. Preflight and project

```bash
testsprite --version
testsprite auth status
```

If missing, tell the user to install the CLI or run `testsprite setup` respectively.
Resolve the project from `$TESTSPRITE_PROJECT_ID`, `.testsprite/config.json`, then
`testsprite project list --output json`; ask if multiple projects match.

For a local app with no project, start it and bootstrap:

```bash
testsprite project create --type frontend --name "<repo name>" --local <port> --local-host <host>
testsprite test create --plan-from plan.json --project <projectId>
testsprite test run <test-id> --local <port> --local-host <host> --output json
```

Local projects need V3 (V2-only: exit 7, `local-origin-requires-v3`). They skip
exploration; `test plan generate` is refused before charge (exit 6). Author plans
with `test create --plan-from` without `--run`, then run each id with `--local`.
Portal runs are blocked for free until `project update <id> --url https://…` sets
a public URL. Deployed projects retain `project create --url`; an empty deployed
suite can use `test plan generate --project <id>` then `test plan accept`.

## 2. Run against the change

Reuse a test covering the change or create one. Public `--target-url` must contain
the new deployment. The CLI does not build/host apps. For local-only changes use
`testsprite test run <test-id> --local <port>` (frontend only).

```bash
# Deployed frontend: create + run, or run an existing test
testsprite test create --plan-from plan.json --run --wait \
  --target-url https://staging.example.com --timeout 600 --output json
testsprite test run <test-id> --target-url https://staging.example.com \
  --wait --timeout 600 --output json
# Backend Python assertion
testsprite test create --type backend --name "Login rejects empty password" \
  --project <id> --code-file /tmp/test.py --run --wait --timeout 600
# Deployed replay (V3 FE: 0.5 credit)
testsprite test rerun <test-id> --wait --output json
# Dependency batch; optional --filter <substring>
testsprite test run --all --project <id> --wait --max-concurrency 4 --output json
```

- Local runs need `run:tunnel`; keys minted before that scope existed must be
  replaced if the CLI names it as missing (exit 3). Free-plan local runs work;
  a V3 frontend run costs 0.5 credit. Backend tests cannot use `--local`.
- `--local` implies `--wait`; timeout defaults to 1200 seconds, ordinary waits
  to 600. `--local-host` accepts `localhost`, `127.0.0.1` (default), or `::1`.
  A dead port exits 5 before charge; `--skip-preflight` bypasses the probe.
  Public `--target-url` rejects localhost/private addresses and excludes `--local`.
- One test per local invocation; parallel invocations are fine. `--all --local`
  exits 5. A user has 5 live tunnel bindings; `tunnel_binding_limit` is exit 11,
  not auto-retried. Stop an unused tunnel or reuse one with `--tunnel-client`.
- Keep the early **stderr** `Run <runId>` receipt, emitted after triggering;
  `Dashboard: <url>` follows when supplied. Stdout remains the JSON result channel.
- An **owned** local timeout, Ctrl-C, or polling failure cancels the run by
  default and closes the tunnel. Check the reported cancellation outcome.
  A run cancelled before it finished is refunded. `--no-cancel-on-interrupt`
  detaches instead, but the owned tunnel still closes and the run remains billable.
- Owned local timeout: start a **new**
  `testsprite test run <test-id> --local <port> --timeout 1800`,
  keeping `--local-host <host>` if used. `test wait` cannot reopen the tunnel.
  Ordinary/adopted waits can resume with `testsprite test wait <run-id>`
  while the target is reachable.
- `tunnel start` (no port) holds a tunnel in a terminal; keep it alive.
  Borrow via `--local <port> --tunnel-client <uuid>`; no automatic cancel or close.
  A second `tunnel start`/process using the same credential takes over; the first exits **10**.
- A case last run through a tunnel stays local: later Portal Run, schedules, or
  bare CLI runs are free BLOCKED (`tunnel-required`, exit 6). Use `--local` again
  or explicitly retarget with public `--target-url`. V3 local runs use the agent
  path, never saved-code replay, and preserve saved code.
- `--wait` handles polling/backoff; do not wrap it in a retry loop.
- Backend Python runs top-to-bottom, not via pytest: call your `test_*` functions.
  The sandbox has stdlib, `requests`, `pytest`, `numpy`, and `scipy`; use HTTP,
  not imports from the project's source or uninstalled packages.
- Backend `--produces`/`--needs` are repeatable; `--category teardown` marks cleanup.
  Set dependencies with `test create` or edit with `test update`; do not delete
  and recreate. Use `test run --all` for producer → consumer → teardown ordering
  and variable passing. A BE `test rerun` includes that closure and its side effects;
  `--skip-dependencies` selects only the named test. Triage failed producers before
  blaming consumers starved of their token/fixture.

## 3. Inspect and report

```bash
testsprite test artifact get <run-id> --out ./.testsprite/runs/<run-id>/
testsprite test steps <test-id> --run-id <run-id> --output json
```

Read the failing step, screenshots and root cause. Bare `test steps <test-id>`
means the latest run's steps; pin the receipt's
run id. An empty latest run does not substitute earlier steps; choose an earlier
id from `test result <test-id> --history`. Report the verdict and dashboard link.

Exits: 0 passed; 1 failed/blocked/cancelled; 3 auth/scope; 4 not found;
5 validation; 6 conflict/precondition; 7 timeout/unsupported; 10 unavailable;
11 rate limited; 12 insufficient credits.

## Dry-run and setup

`--dry-run` works without credentials:

```bash
testsprite test run <test-id> --dry-run --output json
testsprite test create --plan-from plan.json --dry-run --output json
```

Setup: `npm install -g @testsprite/testsprite-cli`, then `testsprite setup`.
