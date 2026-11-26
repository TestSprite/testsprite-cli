import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  rememberCard,
  rememberConversation,
  rememberProject,
  resolveConversationId,
  resolveProject,
  resolveProjectId,
  shownCard,
} from './context.js';

const folder = () => mkdtempSync(join(tmpdir(), 'ts-context-'));

describe('resolveProjectId', () => {
  it('takes the flag, then the environment, then what this folder remembers', () => {
    const root = folder();
    rememberConversation(root, 'p-remembered', 'c1');
    const env = { TESTSPRITE_PROJECT_ID: 'p-env' };
    expect(resolveProjectId('p-flag', { root, env })).toBe('p-flag');
    expect(resolveProjectId(undefined, { root, env })).toBe('p-env');
    expect(resolveProjectId(undefined, { root, env: {} })).toBe('p-remembered');
  });

  it('says how to name a project when none is known', () => {
    expect(() => resolveProjectId(undefined, { root: folder(), env: {} })).toThrow(
      /--project <id>/,
    );
  });
});

describe('resolveProject', () => {
  it('says the project came from this folder only when neither the flag nor the environment named one', () => {
    const root = folder();
    rememberConversation(root, 'p-remembered', 'c1');
    const env = { TESTSPRITE_PROJECT_ID: 'p-env' };
    expect(resolveProject('p-flag', { root, env })).toEqual({
      projectId: 'p-flag',
      remembered: false,
    });
    expect(resolveProject(undefined, { root, env })).toEqual({
      projectId: 'p-env',
      remembered: false,
    });
    expect(resolveProject(undefined, { root, env: {} })).toEqual({
      projectId: 'p-remembered',
      remembered: true,
    });
  });
});

describe('rememberProject', () => {
  it("makes a project this folder's, keeping the conversations and cards it remembers", () => {
    const root = folder();
    rememberConversation(root, 'p-old', 'c-old');
    rememberCard(root, 'c-old', 'card-1');
    rememberProject(root, 'p-new');
    expect(resolveProject(undefined, { root, env: {} })).toEqual({
      projectId: 'p-new',
      remembered: true,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync folder, never user input.
    expect(JSON.parse(readFileSync(join(root, '.testsprite', 'agent.json'), 'utf8'))).toEqual({
      projectId: 'p-new',
      conversations: { 'p-old': 'c-old' },
      cards: { 'c-old': 'card-1' },
    });
  });
});

describe('resolveConversationId', () => {
  it("takes the flag, then this folder's conversation on the project", () => {
    const root = folder();
    rememberConversation(root, 'p1', 'c-here');
    expect(resolveConversationId('c-flag', 'p1', { root })).toBe('c-flag');
    expect(resolveConversationId(undefined, 'p1', { root })).toBe('c-here');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync folder, never user input.
    expect(JSON.parse(readFileSync(join(root, '.testsprite', 'agent.json'), 'utf8'))).toEqual({
      projectId: 'p1',
      conversations: { p1: 'c-here' },
    });
  });

  it("never guesses another folder's or the portal's conversation", () => {
    expect(() => resolveConversationId(undefined, 'p2', { root: folder() })).toThrow(
      /--conversation <id>/,
    );
  });
});

describe('rememberCard', () => {
  it('keeps the card this folder last showed for each conversation', () => {
    const root = folder();
    expect(shownCard(root, 'c1')).toBeUndefined();
    rememberCard(root, 'c1', 'card-1');
    rememberCard(root, 'c2', 'card-9');
    rememberCard(root, 'c1', 'card-2');
    expect(shownCard(root, 'c1')).toBe('card-2');
    expect(shownCard(root, 'c2')).toBe('card-9');
  });
});

describe('rememberConversation', () => {
  it('keeps its folder out of git without touching a .gitignore someone wrote', () => {
    const root = folder();
    rememberConversation(root, 'p1', 'c1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync folder, never user input.
    expect(readFileSync(join(root, '.testsprite', '.gitignore'), 'utf8')).toMatch(/^\*$/m);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync folder, never user input.
    writeFileSync(join(root, '.testsprite', '.gitignore'), 'agent.json\n');
    rememberConversation(root, 'p1', 'c2');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync folder, never user input.
    expect(readFileSync(join(root, '.testsprite', '.gitignore'), 'utf8')).toBe('agent.json\n');
  });
});
