<!--
  User-facing content for `testsprite agent install` (skill: testsprite-ci).
  Body only — name + description frontmatter is emitted by the install wrapper.
  The cursor (.mdc), cline (.clinerules), and antigravity (experimental)
  wrappers reuse this body verbatim and swap only the frontmatter/header.
-->

# TestSprite: gate pull requests in CI

Put `testsprite ci run` into the repo's CI so every pull request's **preview
deployment** is tested before it merges.

This skill uses shipped CLI commands plus `git`, `gh` and the deploy platform's own
CLI. Do **not** call backend APIs directly.

## When to use

- "Add TestSprite to CI / GitHub Actions", "run the tests on every PR", "block merges
  on the tests", "PR gate".
- The project already has tests. If not, onboard it first with the `testsprite-onboard`
  skill.

## When NOT to use

- A nightly run of a fixed environment: `testsprite ci run --project <id> --env <name>`
  on a `schedule:` trigger. No pull-request context is involved.

If this turns out to be more setup than the user wants, the TestSprite GitHub App
(Portal → project → Integrations) runs the same tests on every pull request with one
click.

## 1. Find out how pull requests get deployed (the shape)

Decide from configuration. Read `.github/workflows/` and the repo root, in this order:

- A workflow step already runs `vercel deploy`, `netlify deploy` or a deploy script:
  **B — the workflow deploys**. Trigger: `on: pull_request`.
- No workflow deploys, and `vercel.json` / `.vercel/` / `netlify.toml` or the platform's
  git integration is present: **A — the platform deploys every PR**. Trigger:
  `on: deployment_status`.
- Neither is clear: ask the user who deploys their pull-request previews.

Deployment history is a reference, not the decision:

```bash
gh api repos/{owner}/{repo}/deployments --jq '.[] | "\(.environment) \(.ref[0:8]) \(.created_at)"'
```

Recent **preview** records support A; production-only records mean preview deploys are
off on the platform. History is evidence, not configuration — the proof is a real pull
request (step 5).

Not linked but the user wants A: connect the repository to the platform's git
integration (Vercel: project → Settings → Git, or `npx vercel git connect` with the
user's approval — never `--yes`), or use shape B instead. Installing the platform's
GitHub App is a browser step only the user can do.

## 2. Pick the environment the gate signs in with

```bash
testsprite project env list <project-id>
```

Choose the environment whose **account** the gate should sign in with. `ci run
--target-url` swaps only its address for the pull request's preview; the sign-in
stays. Without `--env` the project's default is written into the workflow **by name**.

## 3. Generate the workflow, then finish it by hand

```bash
testsprite ci init github --project <project-id> --env <name>
```

This writes `.github/workflows/testsprite.yml` with one step marked `REPLACE ME`
(the job fails until it is replaced):

- **A:** change the trigger from `pull_request:` to `deployment_status:` and delete the
  placeholder step; the run then reads the URL from `deployment_status.environment_url`.
  A repo that deploys **several** Vercel projects gets one event per project for the
  same commit — add `&& github.event.deployment.environment == 'Preview – <project>'`
  to the `deployment_status` branch of the `if:`.
- **B:** replace the placeholder's `run:` with the deploy commands, ending in
  `echo "url=<preview address>" >> "$GITHUB_OUTPUT"`. The platform token goes in its
  own repo secret.

Keep what the template fixes: `testsprite ci run … --target-url "$PREVIEW_URL"
--fail-on-skipped --summary-file`, `npm i -g @testsprite/testsprite-cli@latest` (no
version pin — verdicts come from the backend), fork and draft PRs skipped, the upload
step on `if: always()`, and `concurrency` on the **job** (keyed by PR number in B, by
commit in A). Never re-judge pass/fail in YAML (`jq` + `exit 1`): `ci run`'s exit code
is the gate. Regenerate with `--force`; the previous file is kept as `.bak`.

## 4. Secrets

```bash
gh secret set TESTSPRITE_API_KEY        # paste when prompted, or pipe on stdin
```

(`ci init github --set-secret` does the same.) Never put the key in argv, YAML or
logs. A non-production endpoint goes in the workflow `env:` as `TESTSPRITE_API_URL`.
B also needs the platform's deploy token as a secret.

## 5. Preflight, then prove it on one real pull request

Three checks before pushing; each of these otherwise shows up only as a red check
with the cause buried in the job log:

```bash
gh auth status                                  # gh can see this repo
gh secret list | grep TESTSPRITE_API_KEY        # the secret landed (B: the deploy token too)
actionlint .github/workflows/testsprite.yml     # the file parses — or `gh workflow view TestSprite` after the push
```

Commit and push the workflow on a branch, open a PR that is **not a draft** and has
**no merge conflicts**, and watch the `TestSprite / testsprite-tests` check. The log shows
`Dispatched N tests.` then `CI run: x/y passed …`; the job summary is the execution
report (the same content as the App's PR comment); a `testsprite-results` artifact
holds `testsprite-summary.json`. Then suggest making the check **required** in branch
protection. In shape A the workflow file runs **at the deployed commit**, so the PR
branch itself is enough — nothing has to be merged first.

If nothing ran: a draft PR prints `Skipping draft pull request` and exits 0 with no
summary (mark it ready and re-run the job); a PR with merge conflicts never fires
`pull_request` workflows and GitHub shows no error; no run at all, not even the repo's
own workflows, means Actions is disabled on the repository (common on forks) — the
Actions tab shows an enable button; enable it and push an empty commit; in shape A
check that a
`deployment_status` with state `success` arrived for that commit (production
deployments are filtered out by the `if:`).

## Reading the result

- The check is `ci run`'s exit code: 1 = a test failed, 7 = timeout or an unsupported
  backend, 5 = configuration. A summary opening with a **CI gate** warning means the
  CLI's own counts differ from the report (a run it could not read, a timeout) — the
  check is right, the report is the server's view of the execution.
- `exit 7` with "did not confirm the single-execution admission mode" = the backend is
  too old for `ci run`; the dispatched runs were cancelled and refunded.
- Screenshots in the report are capped at 12 per execution; later rows show `—`.
- Shape A is per commit: a new push starts its own run against its own preview, and
  cancelling the job only stops the CLI — the execution keeps running and reports in
  the Portal.
- Backend tests use the URL baked into their code, not `--target-url`.
- Testing `ci run` locally: a shell that exports `TESTSPRITE_API_URL` or
  `TESTSPRITE_API_KEY` overrides `--profile` — a `fetch failed` against a healthy API is
  usually that. Check `env | grep TESTSPRITE_` first.

## Don'ts

- Don't add a CI gate next to the GitHub App on the same project without asking.
- Don't run `vercel link --yes`; don't pass secrets as arguments.
- Don't pin the CLI version in the workflow; don't parse the summary to decide the verdict.
- Don't commit a loopback or private `--target-url` (`ci run` refuses it).
- Don't skip step 5: a workflow that has not run on a real PR is not onboarded.
