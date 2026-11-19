/**
 * Specs never write into the GitHub Actions job they run in (vitest
 * `setupFiles` of the unit and the e2e configs).
 *
 * A command that reads `process.env` (in process, or a spawned CLI that
 * inherits it) appends its job summary to `GITHUB_STEP_SUMMARY`, writes its
 * outputs to `GITHUB_OUTPUT` and prints annotations whenever
 * `GITHUB_ACTIONS=true`. Run in CI, a spec's fixture results then showed up on
 * the real job's page. With these unset a spec behaves in CI as it does
 * locally; one that needs them sets them itself.
 */
for (const key of ['GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT']) {
  delete process.env[key];
}
