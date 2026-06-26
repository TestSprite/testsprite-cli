# feat: `test failure triage` — group batch failures by root cause

## Problem

When many tests fail in the same project run (batch `test run --all`, regression reruns, MCP execute), agents and humans see a flat list of 20–50 separate failures. In practice, those failures often share one underlying root cause:

- authentication / token expired
- staging environment down (`network_timeout`, `infra`)
- broken navigation (`routing_404`)
- shared code defect (`recommendedFixTarget.reference` points to the same file)
- corrupted test data / producer failure cascading to consumers

Today the CLI only supports **per-test** analysis (`test failure get`, `test failure summary`). An agent must download many bundles or guess which test to investigate first.

## Proposed solution (CLI Phase-0)

Add `testsprite test failure triage --project <id>`:

1. List all failed tests in the project (`GET /tests?status=failed`)
2. Fetch lightweight `failure/summary` per test (no screenshots/video)
3. Group client-side using deterministic heuristics over existing M2.1 fields:
   - shared `recommendedFixTarget.reference`
   - env-wide `failureKind` (`infra`, `network`, `network_timeout`, `routing_404`)
   - normalized `rootCauseHypothesis` prefix
   - singleton fallback
4. Return clusters with:
   - `representativeTestId`
   - `memberTestIds`
   - `confidence`
   - `fixPriority` (lower = fix first)

## Why CLI-first (Phase-0)

- Uses only existing public APIs — no backend changes required
- Immediately reduces duplicate investigation, bundle downloads, and token usage
- Becomes the read surface when native backend clustering ships later

## Acceptance criteria

- [ ] `testsprite test failure triage --project <id> --output json` returns clustered output
- [ ] `--type`, `--filter`, `--max-concurrency` supported
- [ ] `--dry-run` returns canned sample
- [ ] Unit tests for grouping logic + integration tests for command
- [ ] DOCUMENTATION.md, README, CHANGELOG, agent skill updated

## Future (backend)

Native clustering API with semantic embeddings, wave/cascade graph, and `--rerun-representatives` orchestration can replace/augment the client-side heuristics.