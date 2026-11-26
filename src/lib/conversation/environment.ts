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
 * what only a person can do there. Said up front so nobody learns it from a
 * run that went half way. An environment on this machine needs no note: the
 * agent asks for the tunnel itself when it finds none.
 */
export function environmentNotes(environment: PlanEnvironment): string[] {
  // Each note is one line naming the server's name: it stays on the line, so
  // it can neither start one nor take the words after it.
  const name = terminalSafeLine(environment.name);
  const notes: string[] = [];
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
