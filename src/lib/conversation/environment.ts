import { loopbackHost } from '../local-target.js';
import { terminalSafeLine } from '../terminal-text.js';

/** An environment as `GET /projects/{id}/env` lists it, as far as a plan needs it. */
export interface PlanEnvironment {
  id?: string;
  name: string;
  url: string;
  isDefault: boolean;
  authMode: string;
  hasCredentials: boolean;
}

/**
 * What the caller should know before the agent starts on this environment:
 * what its browser can't reach and what only a person can do there. Said up
 * front so nobody learns it from a run that went half way.
 */
export function environmentNotes(environment: PlanEnvironment): string[] {
  // Each note is one line naming the server's name and URL: each stays on it,
  // so neither can start a line or take the words between them.
  const name = terminalSafeLine(environment.name);
  const notes: string[] = [];
  let local: { port: string } | null = null;
  try {
    const url = new URL(environment.url);
    if (loopbackHost(url.hostname) !== undefined) local = { port: url.port };
  } catch {
    local = null;
  }
  if (local) {
    notes.push(
      `The "${name}" environment is on this machine (${terminalSafeLine(environment.url)}), which the agent's browser can't open: it works from your change and the project's files. Run what it saves here with \`testsprite run <test-id...> --local ${local.port || '<port>'}\`.`,
    );
  }
  if (environment.authMode === 'manual') {
    notes.push(
      `The "${name}" environment signs in by hand (single sign-on). The agent can't reuse that sign-in yet: it covers what it reaches without signing in, and a person can sign in once in the conversation's live browser.`,
    );
  } else if (environment.authMode === 'account' && !environment.hasCredentials) {
    notes.push(
      `The "${name}" environment has no test account stored, so the agent may only reach what needs no sign-in. A person adds one in the Portal (project → Settings → Environments → ${name}).`,
    );
  }
  return notes;
}
