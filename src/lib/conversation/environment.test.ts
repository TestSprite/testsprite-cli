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

  it("says the agent's browser can't open an app on this machine, and how to run there", () => {
    const [note] = environmentNotes(env({ name: 'local-3000', url: 'http://localhost:3000' }));
    expect(note).toContain("the agent's browser can't open");
    expect(note).toContain('--local 3000');
  });

  it('keeps its own words between a name that opens an escape and a URL that ends one', () => {
    const notes = environmentNotes(
      env({ name: 'stg\u001b]', url: 'http://localhost:3000\u0007', authMode: 'manual' }),
    ).map(note => terminalSafe(note));
    expect(notes[0]).toContain(
      'The "stg" environment is on this machine (http://localhost:3000), which',
    );
    expect(notes[1]).toContain('The "stg" environment signs in by hand');
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
