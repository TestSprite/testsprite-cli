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

- **Small fixes and improvements:** just open a pull request. No issue required.
- **Large or breaking changes** (new commands, changed flags/output, new
  dependencies, refactors): **open an issue first** to discuss the design. This
  avoids wasted work on something we'd ask you to rework or that's out of scope.
- We **do** accept community code contributions — this is an actively maintained
  open-source CLI, not a read-only distribution mirror.
- See [VISION.md](./VISION.md) for what is in and out of scope.

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

## CI gates (required for merge)

- ESLint + Prettier clean
- TypeScript type-check clean
- All unit tests passing
- Coverage ≥ 80% on lines / statements / functions / branches
- Build + smoke test of the CLI binary

Fork pull requests run CI with a **read-only token and no secrets** by design.

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
