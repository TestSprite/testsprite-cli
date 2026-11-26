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
 * `project create` knows the type; a project run on a local environment knows
 * the app is on this machine. `test list` and a cloud `run --project` know neither, so
 * their sentence names the backend API spec as a clause.
 */

import { terminalSafeLine } from './terminal-text.js';

/**
 * The local environment the run that found the project empty was going to: its
 * name, and whether it is the project's default. The agent explores the default
 * unless the request names another, so the planning advice names it otherwise.
 */
export type LocalHint = {
  environment?: string;
  isDefault?: boolean;
};

/**
 * Multi-line `[hint]` block for stderr after a real `project create` (text
 * mode): a new project has no environment and no tests, so it names both
 * steps. A web app may be on this machine rather than deployed, so a frontend
 * project is shown the local environment too; an API runs from the cloud only.
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
    ...(type === 'backend'
      ? []
      : [
          `           (an app on this machine: testsprite project env create ${projectId} --name local --url http://localhost:<port>)`,
        ]),
    `         ${plan}`,
    '         testsprite apply',
  ].join('\n');
}

/**
 * One sentence for an EMPTY project; folded into an error message or a hint.
 *
 * Pass `local` only where the caller knows the project runs on this machine
 * (a project run on a local environment); see the module comment for why the other
 * callers cannot.
 */
export function emptyProjectNextStep(wireProjectId: string, local?: LocalHint | null): string {
  const projectId = terminalSafeLine(wireProjectId);
  if (local) {
    const plan =
      local.environment !== undefined && local.isDefault === false
        ? `testsprite plan "<what to test> on the ${nameForCommand(local.environment)} environment" --project ${projectId}`
        : `testsprite plan --project ${projectId}`;
    // No run command: `apply` prints the one for what it saves.
    return (
      `This project has no tests yet. Ask the project's agent for a first set; its browser ` +
      `opens the app on your machine through a tunnel, so keep testsprite tunnel start ` +
      `running in another terminal: ${plan}, then testsprite apply`
    );
  }
  return (
    `This project has no tests yet. Ask the project's agent for a first set: ` +
    `testsprite plan --project ${projectId}, then testsprite apply ` +
    `(a backend project: attach its API spec with --file <spec>)`
  );
}

/**
 * An environment name for inside the double-quoted request above, or a
 * placeholder. Anyone who can edit the project's environments names them, and
 * no escape is safe in every shell: inside double quotes a POSIX shell runs
 * `$(…)` and backticks, PowerShell runs `$(…)` and escapes with a backtick, and
 * cmd expands `%…%`. Letters, digits, spaces, `.`, `_` and `-` mean nothing to
 * any of them, so such a name goes in as written; any other is the user's to
 * type.
 */
function nameForCommand(name: string): string {
  const shown = terminalSafeLine(name);
  return /^[\p{L}\p{N} ._-]+$/u.test(shown) ? shown : '<environment name>';
}

/** The same sentence as a stderr `[hint]` line. */
export function emptyProjectHint(projectId: string, local?: LocalHint | null): string {
  return `[hint] ${emptyProjectNextStep(projectId, local)}`;
}
