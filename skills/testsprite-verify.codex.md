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
testsprite project create --type frontend --name "<repo name>"
testsprite project env create <projectId> --name local --url http://localhost:<port>
testsprite plan "<what you built>" --diff --project <projectId>
testsprite apply
testsprite run --project <projectId> --env local --output json
```

Portal runs of a local environment are blocked free until a public environment is
the default: `project env create <id> --name staging --url https://… --set-default`.
For a deployed app, `project env create … --url` is the only environment needed.

## 2. Run against the change

The CLI does not host apps. Create a deployed environment once; select it with
`--env <name>` or omit for Default. Unknown names list valid names. A local
environment opens a tunnel from this machine (FE only).

You don't write or edit tests. New tests (frontend or backend): ask the
project's agent, show the user its plan, apply it, run the saved ids. A test
that is itself wrong: `testsprite plan "the <name> test should …"`, then apply.
Exit 13: the agent isn't enabled; say so and stop.

```bash
testsprite plan "<what you built + the user's rules>" --diff --project <id>
testsprite apply   # or --exclude <ref>; or reject "<what to change>"
testsprite project env create <id> --name staging --url https://staging.example.com
# Project suite
testsprite run --project <id> --env staging --wait --output json
# One test
testsprite run <test-id> --env staging --wait --timeout 600 --output json
# Several tests, one batch (FE: 0.5 credit each)
testsprite run <test-id> <test-id> --env staging --wait --output json
# Saved list or positional subset
testsprite run --testlist <listId> --wait
testsprite run <test-id> --testlist <listId> --wait
```

- Supported backends grant existing keys `run:tunnel`; a narrowed key without it
  exits 3. Free-plan local runs work. BE cannot run through a tunnel.
- A tunnel run implies `--wait` (shared 1200 s deadline; public: 600). A dead port exits 5 before charge;
  `--skip-preflight` skips the probe. Environment `--url` rejects private (non-loopback) hosts;
  the app's entry path may follow the port. `--env` keeps its sign-in settings.
- Run local ids together in one `run`; `run --project <id> --env local` skips BE tests. One run per project, one tunnel, 5 tests at once per execution by default
  (`--max-concurrency` 1–15, a server dispatch cap only). Each distinct run is waited on independently. Five live bindings per user; `tunnel_binding_limit`
  exits 11 without retry. Use `tunnel list` then `tunnel stop <id>` or `--all --confirm`.
- Keep each run's `Run <id>` line and its stdout `Dashboard:` link (a no-wait `--testlist` launch has none until `run wait`). All waits return `runs[].runId`,
  `results[].resultId` and counts in `summary`. Only an incomplete timeout or
  interruption adds `partial: true`.
- An **owned** local timeout, Ctrl-C, or poll failure requests cancellation and
  closes the tunnel. Before a terminal FE verdict, the backend attempts a refund;
  check `refund.status`: cancellation does not guarantee a refund.
  `--no-cancel-on-interrupt` detaches, but the owned tunnel still closes.
- After an owned timeout, start a **new** `run <test-id> --env <name>
--timeout 1800`. `run wait` cannot reopen the tunnel;
  ordinary/adopted waits can resume with `run wait <run-id>` if reachable.
- Keep `tunnel start` alive; borrow with `--env <name> --tunnel-client <uuid>`.
  Adopted runs normally detach without cancellation or closing the owner's tunnel.
  If the owner has disappeared during a run, cancellation is requested by default;
  `--no-cancel-on-interrupt` skips it. A second connection with the same credential
  takes over; the first exits **10**.
- Saved loopback frontend environments open a tunnel automatically, including
  list mappings. Lists use pinned environments; no target/env overrides.
- Choose project, named IDs, or list; never combine project with IDs/list.
  No IDs/list: project flag then `TESTSPRITE_PROJECT_ID`. Named/list ignore it.
  `--filter` narrows project selection. Resume with `run wait <run-id...>
--timeout 600`; cancel with `run cancel <run-id...>`. Child flags follow the child.
- `--wait` handles polling/backoff; don't wrap it in a retry loop.
- Use `run --project <project-id>` for backend producer → consumer → teardown ordering
  and variable passing. A BE run includes that closure and its side effects;
  `--skip-dependencies` selects only the named test. Triage failed producers before
  blaming consumers starved of their token/fixture.

## 3. Inspect and report

```bash
testsprite result list --run <run-id> --status failed,blocked   # what did not pass
testsprite result get <result-id> --output json   # error, cause, fix, every step; BE: trace, apiOutput
testsprite result get <result-id> --out .testsprite/results/<result-id>   # evidence
```

Read the result of the run you verify, not an older one (`result list --test
<test-id>` lists them). `--out` writes `result.json`, the video and `steps/`, and
replaces those in an existing dir: one dir per result. Report verdict and links.

Exits: 0 passed; 1 failed/blocked/cancelled; 3 auth/scope; 4 not found;
5 validation; 6 conflict/precondition; 7 timeout/unsupported; 10 unavailable;
11 rate limited; 12 insufficient credits.

## Dry-run and setup

`--dry-run` works without credentials:

```bash
testsprite run <test-id> --dry-run --output json
```

Setup: `npm install -g @testsprite/testsprite-cli`; `testsprite setup`.
