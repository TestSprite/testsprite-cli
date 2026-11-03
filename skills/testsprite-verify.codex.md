# TestSprite Verification Loop

Run relevant tests and inspect failures before reporting. Skip docs/build-config
edits; missing credentials mean unverified. Honor the user's CLI/MCP choice.

## 1. Preflight and project

```bash
testsprite --version
testsprite auth status
```

If missing, advise CLI install or `testsprite setup`. Find the project via
`$TESTSPRITE_PROJECT_ID`, `.testsprite/config.json`, then `testsprite project list
--output json`; ask if several match.

For a local app without a project:

```bash
testsprite project create --type frontend --name "<repo name>" --local <port> --local-host <host>
testsprite test create --plan-from plan.json --project <projectId>
testsprite test run <id> <id> --local <port> --local-host <host> --output json
```

Local projects need V3 (V2-only: exit 7, `local-origin-requires-v3`). Exploration
and `test plan generate` exit 6 before charge. Create plans with `test create
--plan-from` without `--run`; then run several ids with `--local`. Portal runs
are blocked free until `project update <id> --url https://…` sets a public URL.
For deployed projects use `project create --url`; empty suites can use `test plan
generate --project <id>` then `test plan accept`.

## 2. Run against the change

The CLI does not host apps. Create a deployed environment once; select it with
`--env <name>` or omit for Default. Unknown names list valid names. Use `--local
<port>` for local FE runs.

```bash
# Deployed frontend: create + run, or run an existing test
testsprite project env create <id> --name staging --url https://staging.example.com
testsprite test create --plan-from plan.json --run --wait \
  --env staging --timeout 600 --output json
testsprite test run <test-id> --env staging \
  --wait --timeout 600 --output json
# Backend Python assertion
testsprite test create --type backend --name "Login rejects empty password" \
  --project <id> --code-file /tmp/test.py --run --wait --timeout 600
# Several tests, one batch (V3 FE: 0.5 credit each)
testsprite test run <test-id> <test-id> --env staging --wait --output json
# Dependency batch; --filter <substr>, --status failed,blocked
testsprite test run --all --project <id> --env staging --wait --output json
```

- Supported backends grant existing keys `run:tunnel`; a narrowed key without it
  exits 3. Free-plan local runs work. BE cannot use `--local`.
- `--local` implies `--wait` (1200 s per run; ordinary: 600). `--local-host`:
  `localhost`, `127.0.0.1` (default), `::1`. A dead port exits 5 before charge;
  `--skip-preflight` skips the probe. Environment `--url` rejects private (non-loopback) hosts.
  `--local` selects/creates `local-<port>`; a named `--env` must be local.
  `--target-url` cannot combine with `--local`.
- Run local ids together (`test run <id> <id> … --local <port>`); `--all --project
<id> --local <port>` skips BE tests. One tunnel, 5 concurrent runs by default
  (`--max-concurrency` 1–10). Five live bindings per user; `tunnel_binding_limit`
  exits 11 without retry. Use `tunnel list` then `tunnel stop <id>` or `--all --confirm`.
- Keep early **stderr** `Run <runId>` receipts and any `Dashboard: <url>`.
  Stdout is the JSON channel.
- An **owned** local timeout, Ctrl-C, or poll failure requests cancellation and
  closes the tunnel. Before a terminal V3 FE verdict, the backend attempts a refund;
  check `refund.status`: cancellation does not guarantee a refund.
  `--no-cancel-on-interrupt` detaches, but the owned tunnel still closes.
- After an owned timeout, start a **new** `test run <test-id> --local <port>
--timeout 1800` (retain `--local-host`). `test wait` cannot reopen the tunnel;
  ordinary/adopted waits can resume with `test wait <run-id>` if reachable.
- Keep `tunnel start` alive; borrow with `--local <port> --tunnel-client <uuid>`.
  Adopted runs normally detach without cancellation or closing the owner's tunnel.
  If the owner has disappeared during a run, cancellation is requested by default;
  `--no-cancel-on-interrupt` skips it. A second connection with the same credential
  takes over; the first exits **10**.
- Loopback environments need `--local <port>`. Bare CLI runs selecting one by
  name or Default exit 6 (`tunnel-required`) before dispatch or charge. The Portal
  shows no Run; backend requests are refused free. Schedules and test lists get
  free BLOCKED results. A public `--env` or Default works regardless of earlier
  tunnel runs. V3 local runs use the agent path, never saved-code replay, and
  preserve saved code.
- `--wait` handles polling/backoff; don't wrap it in a retry loop.
- Backend Python runs top-to-bottom, not via pytest: call `test_*` functions.
  The sandbox has stdlib, `requests`, `pytest`, `numpy`, `scipy`; use HTTP,
  not project imports or uninstalled packages.
- Backend `--produces`/`--needs` are repeatable; `--category teardown` marks cleanup.
  Set dependencies with `test create` or edit with `test update`; do not delete
  and recreate. Use `test run --all` for producer → consumer → teardown ordering
  and variable passing. A BE run includes that closure and its side effects;
  `--skip-dependencies` selects only the named test. Triage failed producers before
  blaming consumers starved of their token/fixture.

## 3. Inspect and report

```bash
testsprite test artifact get <run-id> --out ./.testsprite/runs/<run-id>/
testsprite test steps <test-id> --run-id <run-id> --output json
```

Read failing steps, screenshots and root cause. Bare `test steps <test-id>`
shows the latest run; pin the receipt's id. For empty latest steps, choose an
earlier run from `test result <test-id> --history`. Report verdict and dashboard.

Exits: 0 passed; 1 failed/blocked/cancelled; 3 auth/scope; 4 not found;
5 validation; 6 conflict/precondition; 7 timeout/unsupported; 10 unavailable;
11 rate limited; 12 insufficient credits.

## Dry-run and setup

`--dry-run` works without credentials:

```bash
testsprite test run <test-id> --dry-run --output json
testsprite test create --plan-from plan.json --dry-run --output json
```

Setup: `npm install -g @testsprite/testsprite-cli`; `testsprite setup`.
