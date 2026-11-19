import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateGitignore } from '../git-utils.js';
import { CLIError } from '../errors.js';

/**
 * What the CLI remembers in a working folder (`.testsprite/agent.json`): the
 * project last worked on here and the conversation last started from here on
 * each project, so the commands that follow need neither. It is this
 * machine's state, so the folder ignores itself in git, as tool caches do.
 */
interface FolderState {
  projectId?: string;
  conversations?: Record<string, string>;
  /** Conversation id → the card this folder last showed for it: what `apply` and `reject` decide. */
  cards?: Record<string, string>;
}

const STATE_DIR = '.testsprite';
const STATE_FILE = 'agent.json';

export interface ContextDeps {
  env?: NodeJS.ProcessEnv;
  /** The folder the state lives in: the repository root, else the working directory. */
  root: string;
}

function readState(root: string): FolderState {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the CLI's own state under the folder it runs in, never a path from input.
    const parsed: unknown = JSON.parse(readFileSync(join(root, STATE_DIR, STATE_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as FolderState) : {};
  } catch {
    return {};
  }
}

function writeState(root: string, state: FolderState): void {
  const dir = join(root, STATE_DIR);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the CLI's own state under the folder it runs in, never a path from input.
  mkdirSync(dir, { recursive: true });
  ensureStateGitignore(dir);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the CLI's own state under the folder it runs in, never a path from input.
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** `--project`, else `TESTSPRITE_PROJECT_ID`, else the project last worked on in this folder. */
export function resolveProjectId(flag: string | undefined, deps: ContextDeps): string {
  const projectId =
    flag?.trim() ||
    (deps.env ?? process.env).TESTSPRITE_PROJECT_ID?.trim() ||
    readState(deps.root).projectId;
  if (!projectId) {
    throw new CLIError(
      'No project. Pass --project <id> (see `testsprite project list`) or set TESTSPRITE_PROJECT_ID; ' +
        'this folder remembers it after that.',
      5,
      'VALIDATION_ERROR',
    );
  }
  return projectId;
}

/** Remember the project and its conversation for the next command run in this folder. */
export function rememberConversation(
  root: string,
  projectId: string,
  conversationId: string,
): void {
  const state = readState(root);
  writeState(root, {
    ...state,
    projectId,
    conversations: { ...state.conversations, [projectId]: conversationId },
  });
}

/**
 * `--conversation`, else the one last started from this folder on the
 * project. Never a guess: a conversation someone else is having, in the
 * portal or another folder, is only ever reached by its id.
 */
export function resolveConversationId(
  flag: string | undefined,
  projectId: string,
  deps: ContextDeps,
): string {
  const id = flag?.trim() || readState(deps.root).conversations?.[projectId];
  if (!id) {
    throw new CLIError(
      'No conversation was started from this folder on this project. Start one with ' +
        '`testsprite plan "<what to test>"`, or name one with --conversation <id> ' +
        '(`testsprite status --list` shows yours).',
      5,
      'VALIDATION_ERROR',
    );
  }
  return id;
}

/** Remember the card a conversation showed here, so `apply` and `reject` decide that one. */
export function rememberCard(root: string, conversationId: string, cardId: string): void {
  const state = readState(root);
  if (state.cards?.[conversationId] === cardId) return;
  writeState(root, { ...state, cards: { ...state.cards, [conversationId]: cardId } });
}

/** The card this folder last showed for a conversation, if any. */
export function shownCard(root: string, conversationId: string): string | undefined {
  return readState(root).cards?.[conversationId];
}
