## Summary

Adds **`testsprite test failure triage --project <id>`** — after a batch run with many failures, groups them into root-cause clusters by calling the **real TestSprite API** (`GET /tests?status=failed` + `GET /tests/{id}/failure/summary` per test). Returns a representative test per cluster so agents investigate one bundle, not thirty.

Closes #<ISSUE_NUMBER>

---

## Real-world problem this solves

| Before | After |
|--------|-------|
| Batch run: 30 tests fail | Same 30 failures |
| Agent sees 30 flat red rows | `failure triage` → 3 clusters |
| Downloads 30 failure bundles | Downloads 1 bundle (representative) |
| Fixes same auth bug 5 times | Fixes root once, reruns representative |

---

## Real production usage

Requires configured API key (`testsprite setup` or `TESTSPRITE_API_KEY`).

```bash
# 1. Run full project suite
testsprite test run --all --project <project-id> --wait --output json

# 2. Triage — real API calls against your project
testsprite test failure triage --project <project-id> --output json

# 3. Investigate highest-priority cluster only
testsprite test failure get <representativeTestId> --out ./.testsprite/failure

# 4. Fix code, verify representative, then full regression
testsprite test rerun <representativeTestId> --wait
testsprite test rerun --all --project <project-id> --wait
```

**With filters:**
```bash
testsprite test failure triage --project <project-id> --type backend --filter checkout --output json
```

**What hits the wire:**

| Step | API | Purpose |
|------|-----|---------|
| 1 | `GET /api/cli/v1/tests?projectId=...&status=failed` | List all failed tests (paginated) |
| 2 | `GET /api/cli/v1/tests/{testId}/failure/summary` × N | Real M2.1 analysis per test (parallel, default 5) |

No bundle download. No screenshots. No video.

> **Note:** If your `~/.testsprite/credentials` points at a local dev proxy (`127.0.0.1`), pass `--endpoint-url https://api.testsprite.com` or fix the profile URL.

---

## Grouping logic (deterministic over real API fields)

| Priority | Groups by | Real scenario |
|----------|-----------|---------------|
| 1 | `recommendedFixTarget.reference` | 8 tests point to same file:line → 1 cluster |
| 2 | `failureKind` ∈ infra/network/network_timeout/routing_404 | 15 tests all `network_timeout` → env outage |
| 3 | Normalized `rootCauseHypothesis` prefix | Similar LLM hypothesis text |
| 4 | Singleton | Independent failures, 1 test per cluster |

Each cluster: `representativeTestId`, `memberTestIds`, `confidence`, `fixPriority` (lower = fix first).

---

## Real test coverage (18 automated tests)

### Unit — `src/lib/failure-triage.test.ts` (11)

| Test | Validates |
|------|-----------|
| `normalizeHypothesis` | Real LLM text with varied spacing groups correctly |
| `computeGroupKey` — fix_target | Same `recommendedFixTarget.reference` → same key |
| `computeGroupKey` — failure_kind | `network_timeout` → env outage cluster |
| `computeGroupKey` — hypothesis | Similar root-cause text groups |
| `computeGroupKey` — singleton | No signal → independent cluster |
| `pickRepresentativeTestId` | Richest hypothesis + freshest `updatedAt` wins |
| `computeClusterConfidence` | Multi fix_target = 0.92, singleton = 0.40 |
| `computeFixPriority` | Infra before assertion bugs |
| `buildFailureClusters` | 3 failures → 2 clusters (shared code + env) |

### Integration — `src/commands/test.test.ts` (7)

Full command against **real HTTP wire shapes** (same mock harness as `runFailureSummary` / `runList`):

| Test | Real scenario |
|------|---------------|
| JSON clusters by shared fix target | 3 failed tests → 2 clusters, correct representative |
| Text mode output | Human triage card |
| Empty project | `GET /tests?status=failed` → `[]`, exit 0 |
| Stale failed row | Summary 404 `no_failing_run` → `summary.skipped` |
| Missing projectId | `VALIDATION_ERROR` exit 5, no API call |
| Command surface + help snapshot | `triage` subcommand registered |

---

## Live API verification (maintainer / reviewer)

Verified against **production** `https://api.testsprite.com` with a real API key (not committed):

```bash
git checkout feat/failure-triage && npm run build

# Auth — all scopes present including read:tests, run:tests
testsprite auth status --output json --endpoint-url https://api.testsprite.com
# → exit 0, scopes: read:projects, read:tests, write:tests, run:tests, ...

# Real project, zero failed tests
testsprite test failure triage --project <project-id> --output json --endpoint-url https://api.testsprite.com
# → exit 0
# → { "clusters": [], "summary": { "totalFailed": 0, "clusterCount": 0, "skipped": 0 } }

# Invalid project id
testsprite test failure triage --project proj_does_not_exist --output json --endpoint-url https://api.testsprite.com
# → exit 4 NOT_FOUND (project validation from API)

# Command exists on built binary
node dist/index.js test failure triage --help
# → shows --project, --type, --filter, --max-concurrency
```

Automated: `npx vitest run src/lib/failure-triage.test.ts` (11/11), `npx vitest run src/commands/test.test.ts -t runFailureTriage` (7/7), `npm run typecheck`, `npm run lint`, `npm run build` — all pass.

---

## Files changed

| File | Purpose |
|------|---------|
| `src/lib/failure-triage.ts` | Grouping, confidence, priority, text renderer |
| `src/lib/failure-triage.test.ts` | 11 unit tests |
| `src/commands/test.ts` | `runFailureTriage()`, API fan-out, Commander |
| `src/commands/test.test.ts` | 7 integration tests |
| `DOCUMENTATION.md`, `README.md`, `CHANGELOG.md` | Docs |
| `skills/testsprite-verify.skill.md` | Agent triage playbook |
| `test/help.snapshot.test.ts.snap` | Help regression guard |

---

## CI gates

- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run build`
- [x] 18 new tests pass
- [x] Live production API smoke test (auth + triage + NOT_FOUND path)