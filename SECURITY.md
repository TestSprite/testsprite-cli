# Security Policy

We take the security of `testsprite-cli` and its users seriously. Thank you for
helping keep the project and its community safe.

## Supported versions

`testsprite-cli` is distributed on npm as
[`@testsprite/testsprite-cli`](https://www.npmjs.com/package/@testsprite/testsprite-cli).
Only the **latest published version** receives security fixes. Please upgrade to
the newest release before reporting an issue:

```bash
npm install -g @testsprite/testsprite-cli@latest
```

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**
Public issues disclose the problem before a fix is available and put users at
risk.

Use one of these private channels instead:

1. **GitHub private vulnerability reporting (preferred).** Open the repository's
   [**Security** tab](https://github.com/TestSprite/testsprite-cli/security) and
   click **Report a vulnerability**. This opens a private advisory visible only
   to you and the maintainers.
2. **Email.** Write to
   [contact@testsprite.com](mailto:contact@testsprite.com) with the subject line
   `SECURITY: testsprite-cli`.

Please include, where possible:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof-of-concept.
- The CLI version (`testsprite --version`) and your OS / Node.js version.
- Any suggested remediation.

## What to expect

- **Acknowledgement** within **5 business days** (best-effort).
- An initial assessment and a proposed remediation timeline once the report is
  triaged.
- Coordinated disclosure: we will work with you on a fix and a disclosure
  timeline, and credit you in the release notes / advisory unless you prefer to
  remain anonymous.

## Scope

In scope:

- The `testsprite-cli` source in this repository and the published npm package.
- Handling of credentials and API keys by the CLI (e.g. local credential
  storage, accidental logging, request construction).
- Supply-chain concerns in this repository (dependencies, CI workflows).

Out of scope (report to TestSprite product support at
[contact@testsprite.com](mailto:contact@testsprite.com) instead):

- The TestSprite hosted API, web dashboard, or backend services. The CLI is a
  client; server-side vulnerabilities are handled through product support
  channels, not this repository.
- Vulnerabilities in third-party dependencies that already have an upstream
  advisory — please still let us know so we can bump the dependency.

## Safe harbor

We will not pursue or support legal action against researchers who:

- Make a good-faith effort to comply with this policy,
- Avoid privacy violations, data destruction, and service degradation, and
- Report promptly and do not exploit the issue beyond what is necessary to
  demonstrate it.

Thank you for contributing to the security of the project.
