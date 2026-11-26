import { describe, expect, it } from 'vitest';
import { terminalSafe } from '../terminal-text.js';
import { environmentNotes, type PlanEnvironment } from './environment.js';

const env = (over: Partial<PlanEnvironment>): PlanEnvironment => ({
  name: 'staging',
  url: 'https://staging.example.com',
  isDefault: false,
  authMode: 'public',
  hasCredentials: false,
  ...over,
});

describe('environmentNotes', () => {
  it('says nothing for a public app anyone can open', () => {
    expect(environmentNotes(env({}))).toEqual([]);
  });

  it('says nothing for an app on this machine: the agent asks for the tunnel itself', () => {
    expect(environmentNotes(env({ name: 'local-3000', url: 'http://localhost:3000' }))).toEqual([]);
  });

  it('keeps its own words after a name that opens an escape', () => {
    const [note] = environmentNotes(env({ name: 'stg\u001b]', authMode: 'manual' })).map(note =>
      terminalSafe(note),
    );
    expect(note).toContain('The "stg" environment signs in by hand');
  });

  it('says a single sign-on needs a person in the live browser', () => {
    expect(environmentNotes(env({ authMode: 'manual' }))[0]).toContain(
      "a person can sign in once in the conversation's live browser",
    );
  });

  it('points at adding a test account when none is stored', () => {
    expect(environmentNotes(env({ authMode: 'account' }))[0]).toContain(
      'in the Portal (project → Settings → Environments → staging)',
    );
  });
});
