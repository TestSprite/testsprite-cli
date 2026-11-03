/**
 * "You have a project, but no tests yet" signposts.
 *
 * A user who is not driving a coding agent otherwise never learns that
 * `test plan generate` exists: `project create` used to print the record and
 * stop, and the empty-project outputs said only "No tests." Every variant also
 * names the hand-authored fallback, because an account not yet on the new
 * platform is refused by generate and pointed at the Portal.
 *
 * Text mode only at every call site: a JSON caller already holds the project
 * id, and stdout and the JSON error envelope must stay unchanged. Never under
 * --dry-run (the id there is the canned sample). Printing a hint runs and
 * charges nothing; the generation it points at does use credits.
 *
 * Zero requests: each call site branches only on what it already knows.
 * `project create` knows the type and whether the app is local; `test run
 * --all --local` knows it is local. `test list` and a cloud `test run --all`
 * know neither, so their sentence names the backend prerequisite as a clause
 * and leaves a local project to the backend's own pre-charge refusal, which
 * carries the same hand-written-plan next step.
 */

import { quoteEnvironmentName } from './environment-tunnel.js';
import { DEFAULT_LOCAL_HOST, type StoredLocalTarget } from './local-target.js';

/**
 * How the run that found the project empty chose its local target, so the
 * suggested `test run` reaches the same app with the same environment:
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

export const FIRST_SUITE_FALLBACK = 'testsprite test create --plan-template';

/**
 * `test run <test-id>` with the target flags the empty run was given. A bare
 * `test run` would resolve the project's DEFAULT environment, which may be a
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
  return ['testsprite test run <test-id>', ...flags].join(' ');
}

/** A URL as one shell word: as typed when it is plain, single-quoted otherwise. */
function shellWord(value: string): string {
  return /^[\w.:/@%+=,~-]+$/.test(value) ? value : quoteEnvironmentName(value);
}

/**
 * Multi-line `[hint]` block for stderr after a real `project create` of a
 * deployed (non-`--local`) project. A `--local` project gets no hint here:
 * its text record already ends with the hand-written-plan next steps (plan
 * generation explores from the cloud with no tunnel, and the backend refuses
 * it for a local-origin project before any charge), and two "Next" blocks
 * would disagree.
 */
export function firstSuiteNextSteps(projectId: string, type: string): string {
  const backend = type === 'backend';
  const lead = backend
    ? 'Next: upload your API spec, then let TestSprite propose your first tests (uses credits), review them, then accept:'
    : 'Next: let TestSprite propose your first tests (uses credits), review them, then accept:';
  const steps = [
    ...(backend ? [`testsprite project docs upload <api-spec.yaml> --project ${projectId}`] : []),
    `testsprite test plan generate --project ${projectId}`,
    `testsprite test plan accept --project ${projectId}`,
  ];
  return [
    `[hint] ${lead}`,
    ...steps.map(s => `         ${s}`),
    `       Prefer to write one yourself: ${FIRST_SUITE_FALLBACK}`,
  ].join('\n');
}

/**
 * One sentence for an EMPTY project; folded into an error message or a hint.
 *
 * Pass `local` only where the caller knows the project runs on this machine
 * (`test run --all --local`); see the module comment for why the other
 * callers cannot.
 */
export function emptyProjectNextStep(projectId: string, local?: LocalHint | null): string {
  if (local) {
    return (
      `This project has no tests yet, and plan generation cannot reach an app on your machine yet. ` +
      `Write a plan yourself: ${FIRST_SUITE_FALLBACK} > first.plan.json, ` +
      `set projectId to ${projectId} in it and edit the steps, create it with ` +
      `testsprite test create --plan-from first.plan.json, ` +
      `then run it with ${localRunCommand(local)}`
    );
  }
  return (
    `This project has no tests yet. Get a first set: ` +
    `testsprite test plan generate --project ${projectId}, then ` +
    `testsprite test plan accept --project ${projectId} ` +
    `(generation uses credits; a backend project needs its API spec uploaded first: ` +
    `testsprite project docs upload <spec> --project ${projectId}). ` +
    `Or write one yourself: ${FIRST_SUITE_FALLBACK}`
  );
}

/** The same sentence as a stderr `[hint]` line. */
export function emptyProjectHint(projectId: string, local?: LocalHint | null): string {
  return `[hint] ${emptyProjectNextStep(projectId, local)}`;
}
