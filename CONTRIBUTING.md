# Contributing to testsprite-cli

Thanks for contributing! Drive-by fixes and small PRs are welcome — you don't
need permission to start. For anything large or breaking, please open an issue
first (see [Contribution model](#contribution-model)) so we can agree on the
approach before you invest time.

## Questions & support

This project is young — if anything is confusing or broken, please tell us:

- 💬 [GitHub Discussions](https://github.com/TestSprite/testsprite-cli/discussions) — questions, ideas, and usage help
- 🗨️ [Discord](https://discord.gg/W4JDrZfdB) — fastest way to reach the team
- 🐛 [GitHub Issues](https://github.com/TestSprite/testsprite-cli/issues) — bug reports and feature requests only
- 🔒 Security reports — **do not** open a public issue; see [SECURITY.md](./SECURITY.md)
- 📧 [contact@testsprite.com](mailto:contact@testsprite.com) — email works too

Please keep **bug reports and feature requests in Issues** and **questions in
Discussions**, so the issue tracker stays a clean, actionable list.

## Contribution model

- **Docs and small fixes** (typos, doc corrections, comment-only changes):
  just open a pull request. No issue required (linking one is still
  appreciated).
- **Features and behavior changes** (new commands or flags, changed output,
  new dependencies, refactors) follow **issue-first**:
  1. Find an existing issue, or open a new one describing the change.
  2. Claim it by commenting `/assign` — the whole comment, on its own line.
     That's the one form the triage bot reliably recognizes. Don't paste
     the literal command anywhere you don't mean it: a mention inside
     prose, a code sample, or a quoted reply may still be picked up as a
     claim, so leave `/assign` out of your comment unless you intend to
     take the issue. A few natural-language phrasings also work (e.g.
     "I'd like to work on this", "can I take this?", "I'll take this").
     Either way, the bot assigns you automatically and replies with how
     many open issues you currently hold.
  3. If the issue is new, wait for triage — we check proposals against
     [VISION.md](./VISION.md) and the [standing policies](#standing-scope-policies)
     below before any code is written, so you don't invest in something
     we'd ask you to rework or decline.
  4. Open your PR with a closing link (e.g. `Closes #123`) in the
     description.
- **PR gate:** a bot checks every non-docs community PR for a closing-linked
  issue that is **assigned to the PR author**. PRs that don't meet this get
  the `needs-issue` label and a failing `gate` check (from the PR-triage
  workflow), and **are not reviewed** until it's fixed — file or claim the
  issue, add the closing link, then edit the PR description (or push a
  commit) to re-run the check.
- Suspected **security vulnerabilities** are the exception to "file an
  issue": report them privately per [SECURITY.md](./SECURITY.md) instead.
- We **do** accept community code contributions — this is an actively maintained
  open-source CLI, not a read-only distribution mirror.
- See [VISION.md](./VISION.md) for what is in and out of scope.

### Standing scope policies

Pre-decided policies, so proposals don't have to relitigate them:

- **Runtime dependencies are budgeted.** The CLI ships with a deliberately
  tiny runtime dependency set (`commander`, `valibot`, plus `undici` —
  approved for `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` support). Any new
  runtime dependency needs explicit maintainer sign-off **in the issue,
  before the PR**. Utility modules land only together with the consumer
  that uses them — standalone libraries are declined.
- **`agent install` targets.** Shipped: `claude`, `antigravity`, `cursor`,
  `cline`, `codex`, `kiro`, `windsurf`, `copilot`. Accepted and in progress:
  `gemini`.
  A proposal for a new target needs (1) the editor's official rules/skill
  file mechanism, documented, and (2) the proposer prepared to maintain the
  target going forward.
- **Outbound network calls.** The CLI talks only to the configured
  TestSprite API endpoint. The one approved exception is an opt-out-able
  npm registry version check (at most once per 24h, carrying nothing but
  the package name, fully silenced by its env opt-out and in CI/JSON/dry-run
  modes or when stderr is not a TTY). Any other outbound call is out of scope.

We aim to give every issue and PR a **first response within 5 business days**
(best-effort). If something has gone quiet longer than that, a polite nudge on
the thread or in Discord is welcome.

## Prerequisites

- Node 20.19+, Node 22.13+, or Node 24+ (development happens on Node 22).

## Build from source

```bash
npm install
npm run build          # tsc → dist/
npm link               # optional: makes `testsprite` resolve to your local checkout
```

The compiled binary lands at `dist/index.js`. During development you can run it
directly with `node dist/index.js <command>`.

## Testing

```bash
npm test               # Vitest unit suite (mock-based; no network or credentials)
npm run test:coverage  # Vitest with v8 coverage (>= 80% gate)
npm run test:e2e       # Local end-to-end suite (builds first; no credentials needed)
```

Unit and local-e2e tests are mock-based and run with no external dependencies —
this is the full suite contributors run locally and in CI. New behavior should
come with tests; keep mocks deterministic (no real timers or network).

## Lint, format, and type-check

```bash
npm run lint           # ESLint
npm run lint:fix       # ESLint with --fix
npm run format         # Prettier (write)
npm run format:check   # Prettier (check only)
npm run typecheck      # tsc --noEmit
```

## Developing on Windows

Native Windows (no WSL, no Git Bash required) is a fully supported dev
environment — you only need **git** and **Node ≥ 20**. `npm ci`, `npm run
build`, `npm test`, `npm run lint`, and `npm run typecheck` all run the same
way as on macOS/Linux, and CI runs the unit suite on `windows-latest` as the
reference environment (see [CI checks](#ci-checks) below) —
if it's green there, it's green on your machine.

A couple of things worth knowing:

- Line endings are normalized to LF on checkout via `.gitattributes`
  (`core.autocrlf` doesn't need any special local configuration).
- `--out`/bundle-path flags accept native Windows paths (`C:\Users\...`)
  including a trailing backslash and a bare drive root (`C:\`).
- A small number of tests that create real filesystem symlinks are skipped on
  Windows (creating a symlink there needs Administrator rights or Developer
  Mode, which isn't guaranteed on hosted CI) — the safety behavior they cover
  is still exercised on the Linux/macOS CI jobs.

Hit something that doesn't work on Windows? Please file it — see
[Questions & support](#questions--support) above, and feel free to tag it
`good first issue` if it looks like an isolated fix; we'd rather know than
have you route around it silently.

## CI checks

These run on every PR and are required by review policy — a maintainer will
not merge a PR with a red check — but nothing at the platform level blocks
the merge button on this repo, so treat them as "must be green before
review," not as an automatic gate:

- ESLint + Prettier clean
- TypeScript type-check clean
- All unit tests passing on Linux (Node 20 + 22) **and** on Windows (`windows-latest`, Node 22)
- Coverage ≥ 80% on lines / statements / functions / branches
- Build + smoke test of the CLI binary

Fork pull requests run CI with a **read-only token and no secrets** by design.

### First PR here? CI needs a maintainer click first

GitHub requires a maintainer to approve a first-time contributor's workflow
run before it starts. If this is your first PR in this repo, your checks tab
will show only a couple of lightweight items (a `gate` check and CodeRabbit)
— the checks listed above will be **absent, not failing**. That's expected
and says nothing about your code: it means the run is queued waiting for
someone to click "Approve and run workflows," not that anything broke.

We don't get an automated signal when a run is stuck in that state, so if
it's been a while (see the response-time note above), ping us on
[Discord](https://discord.gg/W4JDrZfdB) or leave a comment on the PR and
we'll approve the run.

## How we review

Every PR gets an automated first-pass review from [CodeRabbit](https://coderabbit.ai)
(it posts a summary and inline suggestions), followed by a human review covering
correctness, tests, style, scope, and a supply-chain/security check. A code
owner approval is required before merge. The automated review is a helper, not a
gate — a maintainer always makes the final call.

## Branches, pull requests, and releases

- `main` is the only long-lived branch in this repo — it tracks the latest
  released code.
- **To contribute: fork the repo, create a branch in your fork, and open a pull
  request against `main`.** You don't need any access to this repo to do that.
- Branch names use a type prefix: `feat/…`, `fix/…`, `docs/…`, `refactor/…`,
  `test/…`, `chore/…`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)
  — e.g. `feat(cli): …`, `fix(http): …`.
- Keep PRs focused — one logical change per PR is easier to review and merge.
- This repo is the open-source distribution of the TestSprite CLI; the canonical
  development happens internally and is mirrored here. After your PR is merged,
  maintainers fold the change into the internal source of truth and it ships in
  the next release sync — so a file you touched may later be updated by a sync
  commit. Your authorship is preserved in the merge.
- Releases are cut by pushing a semver git tag (`vX.Y.Z`), which publishes the
  package to npm (via OIDC trusted publishing) and creates a GitHub Release.

## Project layout

- `src/commands/` — one module per command group (`auth`, `project`, `test`, `agent`).
- `src/lib/` — shared building blocks: `http` (client + retry/backoff), `poll`
  (run polling), `output` (JSON/text rendering), `config` / `credentials`
  (profile + API-key handling), `errors` (typed envelopes + exit-code mapping),
  `target-url` (URL pre-flight guard), and `dry-run/` (offline sample responses).
- `src/index.ts` — CLI entry point; maps API errors to exit codes.
- `test/` — Vitest unit and snapshot suites; `test/mock-backend/` provides the
  MSW-based fake API used by the unit suite.

See [`DOCUMENTATION.md`](./DOCUMENTATION.md) for the full command reference.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE). No separate CLA is required — inbound
contributions are simply licensed under the project's existing Apache-2.0 terms.
