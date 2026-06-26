## Summary

Adds **`testsprite test failure triage --project <id>`** — groups all failed tests in a project into root-cause clusters using existing M2.1 analysis fields, without downloading failure bundles.

Closes #[ISSUE_NUMBER]

## Motivation

When a batch run produces many failures, agents currently see a flat list and must investigate each test independently. This command collapses duplicate root causes into a few clusters with a representative test, confidence score, and fix priority — reducing bundle downloads, AI tokens, and debug time.

Mentor-approved as CLI Phase-0 triage ahead of native backend clustering.

## What changed

### New command
```bash
testsprite test failure triage --project proj_xxx --output json
testsprite test failure triage --project proj_xxx --type backend --filter checkout --dry-run
```

### Grouping heuristics (deterministic, no LLM)
1. Shared `recommendedFixTarget.reference`
2. Env-wide `failureKind` (`infra`, `network`, `network_timeout`, `routing_404`)
3. Normalized `rootCauseHypothesis` prefix
4. Singleton fallback

### Files
| File | Change |
|------|--------|
| `src/lib/failure-triage.ts` | Grouping logic, confidence/priority scoring, text renderer |
| `src/lib/failure-triage.test.ts` | 11 unit tests |
| `src/commands/test.ts` | `runFailureTriage`, Commander wiring |
| `src/commands/test.test.ts` | 7 integration tests |
| `DOCUMENTATION.md`, `README.md`, `CHANGELOG.md` | Docs |
| `skills/testsprite-verify.skill.md` | Agent triage playbook |
| `test/help.snapshot.test.ts.snap` | Help snapshot |

## Example JSON output
```json
{
  "projectId": "proj_abc",
  "clusters": [
    {
      "clusterId": "cluster_kind_network_timeout",
      "label": "Environment issue (network_timeout)",
      "groupReason": "failure_kind",
      "representativeTestId": "test_a",
      "memberTestIds": ["test_a", "test_b"],
      "confidence": 0.88,
      "fixPriority": 1
    }
  ],
  "summary": { "totalFailed": 2, "clusterCount": 1, "skipped": 0 }
}
```

## Test plan

- [x] `npm run typecheck` — pass
- [x] `npm run lint` — pass
- [x] `npx vitest run src/lib/failure-triage.test.ts` — 11/11 pass
- [x] `npx vitest run src/commands/test.test.ts -t runFailureTriage` — 7/7 pass
- [x] `npm run build` — pass
- [x] Help snapshot added for `test failure triage --help`

## Notes

- Client-side Phase-0 only; when backend ships native clustering, this command can become a thin wrapper over a new read API.
- Skips tests listed as `failed` but with no `failure/summary` (stale status race) — reported in `summary.skipped`.