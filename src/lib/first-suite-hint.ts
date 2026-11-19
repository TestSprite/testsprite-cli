/**
 * "You have a project, but no tests yet" signposts.
 *
 * Tests are written by the project's agent: `testsprite plan` asks it for
 * tests and `testsprite apply` saves what it proposes. A user who is not
 * driving a coding agent otherwise never learns that: `project create` would
 * print the record and stop, and the empty-project outputs would say only
 * "No tests."
 *
 * Text mode only at every call site: a JSON caller already holds the project
 * id, and stdout and the JSON error envelope must stay unchanged. Never under
 * --dry-run (the id there is the canned sample). Printing a hint runs and
 * charges nothing.
 *
 * Zero requests: each call site branches only on what it already knows.
 * `project create` knows the type; `run --project --local` knows the app is
 * on this machine. `test list` and a cloud `run --project` know neither, so
 * their sentence names the backend API spec as a clause.
 */

import { quoteEnvironmentName } from './environment-tunnel.js';
import { DEFAULT_LOCAL_HOST, type StoredLocalTarget } from './local-target.js';
import { terminalSafeLine } from './terminal-text.js';

/**
 * How the run that found the project empty chose its local target, so the
 * suggested `run` reaches the same app with the same environment:
 * `port`/`host` only for an explicit `--local`, `targetUrl` for an explicit
 * `--target-url`, and `environment` for `--env` or the saved environment the
 * tunnel was resolved from.
 */
export type LocalHint = {
  host?: StoredLocalTarget['host'];
  port?: number;
  targetUrl?: string;
  environment?: string;
};

/**
 * `run <test-id>` with the target flags the empty run was given. A bare
 * `run` would resolve the project's DEFAULT environment, which may be a
 * deployed site rather than the app on this machine, so the environment is
 * always named when one was used. `--local-host` is carried whenever the host
 * is not the default: without it a `::1` or `localhost` app would be run
 * against 127.0.0.1.
 */
function localRunCommand(local: LocalHint): string {
  const flags: string[] = [];
  if (local.targetUrl !== undefined) {
    flags.push(`--target-url ${shellWord(local.targetUrl)}`);
  } else if (local.port !== undefined) {
    flags.push(`--local ${local.port}`);
    if (local.host !== undefined && local.host !== DEFAULT_LOCAL_HOST)
      flags.push(`--local-host ${local.host}`);
  }
  if (local.environment !== undefined)
    flags.push(`--env ${quoteEnvironmentName(local.environment)}`);
  return ['testsprite run <test-id>', ...flags].join(' ');
}

/** A URL as one shell word: as typed when it is plain, single-quoted otherwise. */
function shellWord(value: string): string {
  return /^[\w.:/@%+=,~-]+$/.test(value) ? value : quoteEnvironmentName(value);
}

/**
 * Multi-line `[hint]` block for stderr after a real `project create` (text
 * mode): a new project has no environment and no tests, so it names both
 * steps.
 */
export function firstSuiteNextSteps(wireProjectId: string, type: string): string {
  const projectId = terminalSafeLine(wireProjectId);
  const env =
    type === 'backend'
      ? `testsprite project env create ${projectId} --name default --url https://api.example.com`
      : `testsprite project env create ${projectId} --name default --url https://app.example.com`;
  const plan =
    type === 'backend'
      ? `testsprite plan --project ${projectId} --file <api-spec.yaml>`
      : `testsprite plan --project ${projectId}`;
  return [
    '[hint] Next: give the project an environment, then ask its agent for your first tests and apply them:',
    `         ${env}`,
    `         ${plan}`,
    '         testsprite apply',
  ].join('\n');
}

/**
 * One sentence for an EMPTY project; folded into an error message or a hint.
 *
 * Pass `local` only where the caller knows the project runs on this machine
 * (`run --project --local`); see the module comment for why the other
 * callers cannot.
 */
export function emptyProjectNextStep(wireProjectId: string, local?: LocalHint | null): string {
  const projectId = terminalSafeLine(wireProjectId);
  if (local) {
    return (
      `This project has no tests yet. Ask the project's agent for a first set; its browser ` +
      `can't open an app on your machine, so attach your change: ` +
      `testsprite plan --project ${projectId} --diff, then testsprite apply, ` +
      `then run them with ${localRunCommand(local)}`
    );
  }
  return (
    `This project has no tests yet. Ask the project's agent for a first set: ` +
    `testsprite plan --project ${projectId}, then testsprite apply ` +
    `(a backend project: attach its API spec with --file <spec>)`
  );
}

/** The same sentence as a stderr `[hint]` line. */
export function emptyProjectHint(projectId: string, local?: LocalHint | null): string {
  return `[hint] ${emptyProjectNextStep(projectId, local)}`;
}
