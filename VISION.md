# Vision & Scope

This document explains what `testsprite-cli` is for, what belongs in it, and how
it is governed — so contributors can tell, before writing code, whether an idea
fits.

## What this is

`testsprite-cli` is the command-line interface to [TestSprite](https://www.testsprite.com),
the verification layer for the agentic coding era. It lets you — and your coding
agent — create tests, run them against a live app, and read back exactly what
broke, all from the terminal and from scripts.

It is designed to be:

- **Agent-first.** Output is structured and stable so a coding agent can act on
  it. Every command works in `--output json`, and exit codes are a documented,
  scriptable contract.
- **A thin, well-behaved client.** The CLI talks to TestSprite's hosted API. It
  validates input, handles auth, retries, polling, and rendering — it does not
  re-implement the platform.
- **Composable and safe by default.** Stdout stays parseable (human chatter goes
  to stderr), destructive actions are explicit, and dry-run is available
  everywhere.

## In scope

- Commands, flags, output formats, and ergonomics of the CLI itself.
- Authentication and local credential/profile handling.
- Integration with coding agents (e.g. the `agent install` skills).
- Reliability of client behavior: retries, timeouts, polling, idempotency,
  pagination, exit-code mapping.
- Documentation, examples, and the contributor/onboarding experience.

## Out of scope (non-goals)

- **Server-side product behavior.** Test execution, plan generation, browser
  automation, and credit/billing logic live in the TestSprite platform, not in
  this CLI. The CLI surfaces them; it does not implement them. Requests to change
  _how tests run_ belong with product support, not here.
- **A general-purpose test framework.** This is a client for TestSprite, not a
  standalone runner that works without an account.
- **Re-implementing the web dashboard.** The CLI is a complement to the dashboard,
  optimized for terminals, CI, and agents — not a full UI replacement.
- **Vendoring provider-specific logic** that would couple the CLI to one CI
  system or one agent. Keep integrations thin and optional.

If you're unsure whether something is in scope, open an issue or a Discussion
before building it.

## Relationship to the product

This CLI is open source under Apache-2.0 and free to use. Running tests against
your app requires a TestSprite account and API key (a free tier is available).
The CLI is the open-source distribution of the tool; the canonical development
happens internally and is mirrored to this repository, and merged community
contributions are folded back into that source of truth (see
[CONTRIBUTING.md](./CONTRIBUTING.md)).

## Stability & versioning

- The package follows [semantic versioning](https://semver.org). Breaking
  changes to commands, flags, output shape, or exit codes are treated as such.
- Exit codes and `--output json` shapes are part of the public contract — we
  avoid breaking them, and call it out in release notes when we must.

## Governance

- **Operator / maintainer:** [@zeshi-du](https://github.com/zeshi-du) currently
  owns releases and final merge decisions, with [@ruili-testsprite](https://github.com/ruili-testsprite)
  as a maintainer helping triage and review. Maintainers are listed via
  [CODEOWNERS](./.github/CODEOWNERS).
- **Decisions** are made in the open on issues and pull requests. For
  significant or breaking changes, an issue is opened first to gather input
  before implementation.
- **Becoming a maintainer:** sustained, high-quality contributions and good
  judgment in review are the path. If you'd like to take on more, say so on a
  thread or in Discord.
- **Code of Conduct:** participation is governed by our
  [Code of Conduct](./CODE_OF_CONDUCT.md).
- **Security:** see [SECURITY.md](./SECURITY.md) for private vulnerability
  reporting.

## Roadmap

Active work and proposals live in
[Issues](https://github.com/TestSprite/testsprite-cli/issues) and
[Discussions](https://github.com/TestSprite/testsprite-cli/discussions). There's
no separate roadmap document — the issue tracker is the roadmap.
