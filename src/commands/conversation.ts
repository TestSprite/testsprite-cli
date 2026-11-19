import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { Command, Option } from 'commander';
import { detectCallerFromEnv } from '../lib/agent-detect.js';
import {
  makeHttpClient,
  parseRequestTimeoutFlag,
  resolveRequestTimeoutMs,
  type CommonOptions,
} from '../lib/client-factory.js';
import { resolveProfileName } from '../lib/config.js';
import { CLIError, InterruptError } from '../lib/errors.js';
import { answersFor } from '../lib/conversation/answers.js';
import type { FetchImpl, HttpClient } from '../lib/http.js';
import { globalShutdown } from '../lib/interrupt.js';
import {
  waitForRun,
  resolveRunWaitFailure,
  type RunWaitSnapshot,
  type RunWaitOutcome,
} from '../lib/run-wait.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode } from '../lib/output.js';
import { promptSecret } from '../lib/prompt.js';
import { conversationApi, type ConversationApi } from '../lib/conversation/api.js';
import { readChange, readRepository, runGit, type Git } from '../lib/conversation/change.js';
import {
  rememberCard,
  rememberConversation,
  resolveConversationId,
  resolveProjectId,
  shownCard,
} from '../lib/conversation/context.js';
import { environmentNotes } from '../lib/conversation/environment.js';
import { followConversation, type FollowResult } from '../lib/conversation/follow.js';
import { titleFrom } from '../lib/conversation/title.js';
import {
  nextSteps,
  type NextStep,
  prSummary,
  renderApplied,
  renderConversation,
  renderConversationList,
  renderEvent,
  waitingNotes,
} from '../lib/conversation/render.js';
import type {
  Brief,
  Conversation,
  ConversationEvent,
  ApplyResult,
} from '../lib/conversation/types.js';

import { jsonForTerminal, terminalSafeLine, terminalSafeWriter } from '../lib/terminal-text.js';

export interface ConversationDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  cwd?: string;
  git?: Git;
  /** A person at a terminal, who can type a password and watch without a deadline. */
  interactive?: boolean;
  promptSecret?: (question: string) => Promise<string>;
  /** Everything piped to the command, for `apply --secret-stdin`. */
  readStdin?: () => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Under the ten minutes a coding agent's shell command may take, with room to print. */
const AGENT_WAIT_SECONDS = 540;
/** The most files one message carries, the change included. */
const MAX_FILES = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

interface Context {
  opts: CommonOptions;
  out: Output;
  /** A line of the CLI's own on stderr, made safe for a terminal. */
  stderr: (line: string) => void;
  /** One JSON value on a line of stderr (`--output json` progress). */
  stderrJson: (value: unknown) => void;
  api: ConversationApi;
  client: HttpClient;
  root: string;
  interactive: boolean;
  deps: ConversationDeps;
}

interface WaitFlags {
  wait?: boolean;
  timeout?: string;
}

interface Attachment {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

function context(command: Command, deps: ConversationDeps): Context {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & {
    requestTimeout?: string;
  };
  const opts: CommonOptions = {
    profile: resolveProfileName(globals.profile, deps.env),
    output: resolveOutputMode(globals.output),
    endpointUrl: globals.endpointUrl,
    debug: globals.debug ?? false,
    verbose: globals.verbose ?? false,
    dryRun: globals.dryRun ?? false,
    requestTimeoutMs: parseRequestTimeoutFlag(globals.requestTimeout),
  };
  const stderr = terminalSafeWriter(deps.stderr);
  const client = makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
  });
  const cwd = deps.cwd ?? process.cwd();
  return {
    opts,
    out: new Output(opts.output, { stdout: deps.stdout, stderr: deps.stderr }),
    stderr,
    stderrJson: value =>
      (deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`)))(
        jsonForTerminal(value),
      ),
    client,
    api: conversationApi(client, deps.fetchImpl ?? globalThis.fetch.bind(globalThis), {
      // A file's PUT to storage goes around the client, so it is handed the
      // per-request timeout the client itself resolved from the same inputs.
      requestTimeoutMs: resolveRequestTimeoutMs(opts, deps.env ?? process.env),
    }),
    root: readRepository(cwd, deps.git ?? runGit)?.root ?? cwd,
    interactive:
      deps.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true),
    deps,
  };
}

function timeoutMs(ctx: Context, flags: WaitFlags): number | null {
  if (flags.timeout !== undefined) {
    const seconds = Number(flags.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new CLIError('--timeout must be a positive number of seconds.', 5, 'VALIDATION_ERROR');
    }
    return seconds * 1000;
  }
  return ctx.interactive ? null : AGENT_WAIT_SECONDS * 1000;
}

/**
 * Follow the conversation until the agent needs someone, printing its
 * progress on stderr, then print where it stands on stdout. A conversation the
 * agent stopped short, or one still running at the deadline, exits non-zero.
 */
async function finishTurn(
  ctx: Context,
  projectId: string,
  id: string,
  afterSeq: number,
  flags: { wait?: boolean; steps?: boolean; deadlineMs: number | null },
  extra: Record<string, unknown> = {},
  first: NextStep[] = [],
): Promise<void> {
  if (flags.wait === false) {
    const conversation = await ctx.api.get(projectId, id);
    print(ctx, conversation, [], flags.steps, extra, first);
    return;
  }
  const result = await follow(ctx, projectId, id, afterSeq, flags.deadlineMs);
  settle(ctx, result, flags.steps, extra, first);
}

/** Follow the agent until it needs someone, printing its progress on stderr. */
async function follow(
  ctx: Context,
  projectId: string,
  id: string,
  afterSeq: number,
  timeoutMs: number | null,
): Promise<FollowResult> {
  const json = ctx.opts.output === 'json';
  try {
    return await followConversation(ctx.api, projectId, id, {
      afterSeq,
      timeoutMs,
      onEvent: event => {
        if (json) {
          ctx.stderrJson(event);
          return;
        }
        const line = renderEvent(event);
        if (line !== null) ctx.stderr(line);
      },
      now: ctx.deps.now,
      sleep: ctx.deps.sleep,
    });
  } catch (err) {
    if (err instanceof InterruptError) {
      ctx.stderr(
        'Stopped following. The agent keeps working: `testsprite status --wait` picks it up again, `testsprite stop` stops it.',
      );
    }
    throw err;
  }
}

/** Print where the conversation stands, then exit as the exit codes say. */
function settle(
  ctx: Context,
  result: FollowResult,
  steps: boolean | undefined,
  extra: Record<string, unknown>,
  first: NextStep[],
): void {
  print(ctx, result.conversation, result.events, steps, extra, first);
  const { conversation } = result;
  if (result.timedOut) {
    throw new CLIError(
      'The agent is still working. Follow it with `testsprite status --wait`.',
      7,
      'TIMEOUT',
    );
  }
  failIfOver(conversation);
}

/** Exit 1 when the agent stopped short or the conversation ended, as the exit codes say. */
function failIfOver(conversation: Conversation): void {
  if (conversation.state === 'stopped' || conversation.state === 'ended') {
    throw new CLIError(
      conversation.state === 'ended'
        ? 'This conversation has ended.'
        : `The agent stopped before it finished (${conversation.stopReason ?? 'unknown reason'}).`,
      1,
      'AGENT_STOPPED',
    );
  }
}

function print(
  ctx: Context,
  conversation: Conversation,
  events: ConversationEvent[],
  steps?: boolean,
  extra: Record<string, unknown> = {},
  first: NextStep[] = [],
): void {
  const replyShown = events.some(
    e => e.kind === 'message' && e.from === 'agent' && e.text === conversation.reply,
  );
  const next = [...first, ...nextSteps(conversation)];
  ctx.out.print({ ...extra, ...conversation, events, next }, () =>
    renderConversation(conversation, { steps, replyShown, next }),
  );
  // What was shown here is what `apply` and `reject` will decide.
  if (conversation.proposal && !ctx.opts.dryRun) {
    rememberCard(ctx.root, conversation.id, conversation.proposal.id);
  }
}

/**
 * The card to decide: the one named, else the one last shown in this folder,
 * else the one waiting now. A card shown here that no longer waits is refused,
 * so nobody decides a card they haven't seen.
 */
function cardToDecide(
  ctx: Context,
  now: Conversation,
  flag: string | undefined,
): string | undefined {
  const card = flag?.trim() || shownCard(ctx.root, now.id) || now.proposal?.id;
  if (card && now.proposal && card !== now.proposal.id) {
    throw new CLIError(
      `The card shown here before is not the one waiting now: the agent now waits on "${now.proposal.summary}", which you haven't seen. Look at it with \`testsprite status\`, then decide again.`,
      6,
      'CONFLICT',
    );
  }
  return card;
}

function readAttachments(
  ctx: Context,
  files: string[],
  diff: string | boolean | undefined,
): { attachments: Attachment[]; brief: Pick<Brief, 'repository' | 'change'>; notes: string[] } {
  const attachments: Attachment[] = [];
  const notes: string[] = [];
  const repo = readRepository(ctx.deps.cwd ?? process.cwd(), ctx.deps.git ?? runGit);
  const brief: Pick<Brief, 'repository' | 'change'> = repo
    ? { repository: { name: repo.name, branch: repo.branch, commit: repo.commit } }
    : {};
  if (diff !== undefined && diff !== false) {
    if (!repo) {
      throw new CLIError('--diff needs a git repository.', 5, 'VALIDATION_ERROR');
    }
    const change = readChange(repo, typeof diff === 'string' ? diff : undefined, ctx.deps.git);
    if (!change.patch) {
      notes.push(`No change since ${change.base.slice(0, 12)}; nothing attached.`);
    } else {
      attachments.push({
        name: 'change.patch',
        contentType: 'text/x-diff',
        bytes: new TextEncoder().encode(change.patch),
      });
      brief.change = 'change.patch';
      notes.push(
        `Attached the change since ${change.base.slice(0, 12)}: ${change.files.length} ${change.files.length === 1 ? 'file' : 'files'}.`,
      );
    }
    if (change.left.length) {
      notes.push(`Left out (may hold secrets, or not source): ${change.left.join(', ')}.`);
    }
  }
  for (const path of files) {
    let size: number;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path the user names with --file to attach; reading it is the point.
      size = statSync(path).size;
    } catch {
      throw new CLIError(`--file ${path}: no such file.`, 5, 'VALIDATION_ERROR');
    }
    if (size > MAX_FILE_BYTES) {
      throw new CLIError(`--file ${path} is over 50 MB.`, 5, 'VALIDATION_ERROR');
    }
    attachments.push({
      name: basename(path),
      contentType: contentTypeOf(path),
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path the user names with --file to attach; reading it is the point.
      bytes: readFileSync(path),
    });
    notes.push(`Attached ${basename(path)}.`);
  }
  if (attachments.length > MAX_FILES) {
    throw new CLIError(`A message carries at most ${MAX_FILES} files.`, 5, 'VALIDATION_ERROR');
  }
  return { attachments, brief, notes };
}

async function upload(
  ctx: Context,
  projectId: string,
  id: string,
  attachments: Attachment[],
): Promise<string[]> {
  if (ctx.opts.dryRun) return attachments.map(a => a.name);
  const names: string[] = [];
  for (const attachment of attachments) names.push(await ctx.api.upload(projectId, id, attachment));
  return names;
}

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.patch': 'text/x-diff',
  '.diff': 'text/x-diff',
};

const contentTypeOf = (path: string) =>
  CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

function caller(env: NodeJS.ProcessEnv, interactive: boolean): Brief['caller'] {
  return detectCallerFromEnv(env).length > 0 || !interactive ? 'agent' : 'person';
}

async function current(
  ctx: Context,
  flags: { project?: string; conversation?: string },
): Promise<{ projectId: string; id: string }> {
  const projectId = resolveProjectId(flags.project, { env: ctx.deps.env, root: ctx.root });
  const id = resolveConversationId(flags.conversation, projectId, {
    env: ctx.deps.env,
    root: ctx.root,
  });
  return { projectId, id };
}

const CARD_HELP =
  'the card to decide, by the id the conversation showed (default: the one last shown in this folder); one decided meanwhile is refused';

const collect = (value: string, previous: string[] = []) => [...previous, value];

/**
 * A question card is answered with `--answer`, every question at once, so the
 * card is never decided empty; any other card takes no answers. A card shown
 * here that no longer waits is not judged: it goes to the server, which says
 * how it was decided meanwhile.
 */
/**
 * The environment `--env` names for a run card. On a card shown here that
 * starts no run it is refused before anything is sent; a card not shown here
 * goes to the server, which says how it was decided.
 */
function environmentOn(now: Conversation, card: string, given: string | undefined) {
  if (given === undefined) return undefined;
  if (!given.trim()) {
    throw new CLIError('`--env` needs the name of an environment.', 5, 'VALIDATION_ERROR');
  }
  if (now.proposal?.id === card && now.proposal.kind !== 'run') {
    throw new CLIError(
      'This card starts no run; `--env` is for a card that does.',
      5,
      'VALIDATION_ERROR',
    );
  }
  return given.trim();
}

function answersOn(
  now: Conversation,
  card: string,
  given: string[] | undefined,
): Record<string, string> | undefined {
  if (now.proposal?.id !== card) return undefined;
  if (now.proposal.kind !== 'question') {
    if (given?.length) {
      throw new CLIError(
        'This card asks no questions; `--answer` is for a card that does.',
        5,
        'VALIDATION_ERROR',
      );
    }
    return undefined;
  }
  return answersFor(now.proposal.questions ?? [], given ?? []);
}
const refs = (values: string[] | undefined) =>
  values
    ?.flatMap(v => v.split(','))
    .map(v => v.trim())
    .filter(Boolean);

function addWaitOptions(cmd: Command): Command {
  return cmd
    .option('--no-wait', 'return as soon as the agent has it, without following it')
    .option(
      '--timeout <seconds>',
      `stop following after this long (default: no limit in a terminal, ${AGENT_WAIT_SECONDS}s otherwise); the agent keeps working`,
    );
}

function addTarget(cmd: Command, conversation = true): Command {
  cmd.option(
    '--project <id>',
    'project id (default: TESTSPRITE_PROJECT_ID, else the one last used in this folder)',
  );
  if (conversation) {
    cmd.option(
      '--conversation <id>',
      'conversation id (default: the one last started from this folder)',
    );
  }
  return cmd;
}

const EXIT_CODES =
  '\nExit codes:\n' +
  '  0   the agent proposed something or replied\n' +
  '  1   the agent stopped before it finished, or the conversation ended\n' +
  '  5   invalid input (no project, a missing file, --diff outside a repository)\n' +
  '  6   the conversation is not waiting for this (e.g. apply with nothing proposed)\n' +
  '  7   still working at --timeout; follow it with `testsprite status --wait`\n' +
  '  13  the agent is not enabled for this account\n';

async function planNotes(ctx: Context, projectId: string): Promise<string[]> {
  const quietly = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (err) {
      if (err instanceof InterruptError) throw err;
      return null;
    }
  };
  const [environments, conversations] = await Promise.all([
    quietly(() => ctx.api.environments(projectId)),
    quietly(() => ctx.api.list(projectId)),
  ]);
  const environment = environments?.find(e => e.isDefault);
  return [
    ...(environment ? environmentNotes(environment) : []),
    ...waitingNotes(conversations ?? []),
  ];
}

export function createPlanCommand(deps: ConversationDeps = {}): Command {
  const cmd = new Command('plan')
    .summary('Ask the agent to plan tests: it explores your app and proposes changes to the suite')
    .description(
      "Start a conversation with the project's agent, the same one the portal has. It explores your app, " +
        'writes or fixes test cases, and proposes them as a plan you apply or reject. Say what to test, ' +
        'or what went wrong; attach your change with --diff and documents with --file.',
    )
    .argument('[request...]', 'what to test, in your own words')
    .option(
      '--diff [base]',
      'attach your change since <base> (default: where this branch left the default branch)',
    )
    .option('--file <path>', 'attach a document: a PRD, a ticket, a spec (repeatable)', collect)
    .addOption(
      new Option(
        '--model <id>',
        'the model the agent runs on, like claude-haiku-5-5 (default: the portal default)',
      ),
    );
  addTarget(cmd, false);
  addWaitOptions(cmd);
  return cmd
    .option('--steps', 'show each proposed test step by step')
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  testsprite plan "cover the new coupon rules" --diff --file docs/coupons-prd.md\n' +
        '  testsprite plan "the checkout tests fail since the redesign; fix the tests, report real bugs"\n' +
        '  testsprite plan --diff --no-wait     # start it and come back with `testsprite status --wait`\n' +
        EXIT_CODES +
        GLOBAL_OPTS_HINT,
    )
    .action(async (words: string[], flags, command: Command) => {
      const ctx = context(command, deps);
      const deadlineMs = timeoutMs(ctx, flags);
      const projectId = resolveProjectId(flags.project as string | undefined, {
        env: ctx.deps.env,
        root: ctx.root,
      });
      const {
        attachments,
        brief,
        notes: attached,
      } = readAttachments(
        ctx,
        (flags.file as string[] | undefined) ?? [],
        flags.diff as string | boolean | undefined,
      );
      const notes = await planNotes(ctx, projectId);
      const text =
        words.join(' ').trim() ||
        (brief.change
          ? 'Plan tests for the change I am working on.'
          : 'Plan tests for this project.');
      const started = await ctx.api.start(projectId, {
        model: flags.model as string | undefined,
        title: titleFrom(text),
      });
      const files = await upload(ctx, projectId, started.id, attachments);
      await ctx.api.send(projectId, started.id, {
        text,
        ...(files.length ? { files } : {}),
        brief: {
          caller: caller(ctx.deps.env ?? process.env, ctx.interactive),
          ...brief,
        },
      });
      if (!ctx.opts.dryRun) rememberConversation(ctx.root, projectId, started.id);
      for (const note of [...attached, ...notes]) ctx.stderr(note);
      ctx.stderr(`The agent is on it: ${terminalSafeLine(started.url)}`);
      await finishTurn(
        ctx,
        projectId,
        started.id,
        0,
        { ...flags, deadlineMs },
        notes.length ? { notices: notes } : {},
      );
    });
}

export function createReplyCommand(deps: ConversationDeps = {}): Command {
  const cmd = new Command('reply')
    .summary('Answer the agent, or ask it for more, in the same conversation')
    .argument('<message...>', 'what to tell the agent')
    .option('--diff [base]', 'attach your change since <base>')
    .option('--file <path>', 'attach a document (repeatable)', collect);
  addTarget(cmd);
  addWaitOptions(cmd);
  return cmd
    .option('--steps', 'show each proposed test step by step')
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  testsprite reply "use the qa-admin account for the admin pages"\n' +
        '  testsprite reply "the last run failed; which failures are real bugs?"\n' +
        EXIT_CODES +
        GLOBAL_OPTS_HINT,
    )
    .action(async (words: string[], flags, command: Command) => {
      const ctx = context(command, deps);
      const deadlineMs = timeoutMs(ctx, flags);
      const { projectId, id } = await current(ctx, flags);
      const { attachments, notes } = readAttachments(
        ctx,
        (flags.file as string[] | undefined) ?? [],
        flags.diff as string | boolean | undefined,
      );
      const now = await ctx.api.get(projectId, id);
      if (now.state === 'ended') {
        throw new CLIError(
          'This conversation has ended. Start a new one with `testsprite plan "<what to test>"`.',
          6,
          'CONFLICT',
        );
      }
      if (now.state === 'proposed') {
        throw new CLIError(
          'The agent is waiting for you to apply or reject what it proposed. To ask for changes to it: testsprite reject "<what to change>".',
          6,
          'CONFLICT',
        );
      }
      const files = await upload(ctx, projectId, id, attachments);
      await ctx.api.send(projectId, id, {
        text: words.join(' '),
        ...(files.length ? { files } : {}),
      });
      for (const note of notes) ctx.stderr(note);
      await finishTurn(ctx, projectId, id, now.lastSeq, { ...flags, deadlineMs });
    });
}

export function createStatusCommand(deps: ConversationDeps = {}): Command {
  const cmd = new Command('status')
    .summary('Where the agent is: working, waiting for you, or done')
    .option('--wait', 'follow it until it needs you')
    .option(
      '--timeout <seconds>',
      `with --wait, stop following after this long (default: no limit in a terminal, ${AGENT_WAIT_SECONDS}s otherwise)`,
    )
    .option('--steps', 'show each proposed test step by step')
    .option('--list', 'list your conversations with the agent on the project');
  addTarget(cmd);
  return cmd
    .addHelpText('after', EXIT_CODES + GLOBAL_OPTS_HINT)
    .action(async (flags, command: Command) => {
      const ctx = context(command, deps);
      const deadlineMs = timeoutMs(ctx, flags);
      if (flags.list) {
        const projectId = resolveProjectId(flags.project as string | undefined, {
          env: ctx.deps.env,
          root: ctx.root,
        });
        const conversations = await ctx.api.list(projectId);
        ctx.out.print({ conversations }, () => renderConversationList(conversations));
        return;
      }
      const { projectId, id } = await current(ctx, flags);
      const now = await ctx.api.get(projectId, id);
      if (!flags.wait || now.state !== 'working') {
        print(ctx, now, [], flags.steps as boolean | undefined);
        failIfOver(now);
        return;
      }
      await finishTurn(ctx, projectId, id, now.lastSeq, {
        steps: flags.steps as boolean | undefined,
        deadlineMs,
      });
    });
}

export function createApplyCommand(deps: ConversationDeps = {}): Command {
  const cmd = new Command('apply')
    .summary(
      'Apply what the agent proposed, as the portal card does: save the plan, the environment, or start the run',
    )
    .description(
      'Apply what the agent proposed, as the portal card does: save the plan, the environment, the ' +
        "schedule or the project's settings, or start the run. A run it starts is waited for, and its " +
        'results go back to the agent, which reads them and replies.',
    )
    .option(
      '--only <tests>',
      'apply only these tests of the plan, by the refs it lists (comma-separated)',
      collect,
    )
    .option('--exclude <tests>', 'apply the plan without these tests (comma-separated)', collect)
    .option(
      '--secret-stdin',
      'for a card that asks for a secret (a password, a token): read it from what is piped in',
    )
    .option(
      '--answer <n=choice>',
      "for a card that asks questions: answer question n with an option's letter (letters comma-separated when it takes several) or your own words (repeatable)",
      collect,
    )
    .option(
      '--env <name>',
      'for a card that starts a run: run it on this environment instead of the one the card names',
    )
    .option('--card <id>', CARD_HELP);
  addTarget(cmd);
  addWaitOptions(cmd);
  return cmd
    .option('--steps', 'show each proposed test step by step')
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  testsprite apply\n' +
        '  testsprite apply --exclude 3,CHK-009\n' +
        '  testsprite apply --answer 1=b --answer 2=a,c\n' +
        '  testsprite apply --env staging\n' +
        EXIT_CODES +
        GLOBAL_OPTS_HINT,
    )
    .action(async (flags, command: Command) => {
      const ctx = context(command, deps);
      const deadlineMs = timeoutMs(ctx, flags);
      const startedAt = (deps.now ?? Date.now)();
      const { projectId, id } = await current(ctx, flags);
      const now = await ctx.api.get(projectId, id);
      // A card shown here that no longer waits goes to the server, which says how it was decided.
      const card = cardToDecide(ctx, now, flags.card as string | undefined);
      if (!card) {
        throw new CLIError(
          `Nothing is waiting to be applied: ${now.state === 'working' ? 'the agent is still working' : `the conversation is ${now.state}`}. See \`testsprite status\`.`,
          6,
          'CONFLICT',
        );
      }
      const answers = answersOn(now, card, flags.answer as string[] | undefined);
      const environment = environmentOn(now, card, flags.env as string | undefined);
      const secret = await secretFor(ctx, now, card, flags.secretStdin === true);
      const applied = await ctx.api.apply(projectId, id, {
        card,
        only: refs(flags.only as string[] | undefined),
        exclude: refs(flags.exclude as string[] | undefined),
        ...(secret !== undefined ? { secrets: { value: secret } } : {}),
        ...(answers ? { answers } : {}),
        ...(environment !== undefined ? { environment } : {}),
      });
      const forPr = prSummary(applied, now.url);
      // Everything below prints this one object, which names the launch of a
      // run the proposal started `run.runId`.
      const printed = applied;
      if (ctx.opts.output === 'text') {
        ctx.stderr(renderApplied(printed));
        const forPrText = prSummary(applied, now.url, terminalSafeLine);
        if (forPrText) ctx.stderr(`\nFor the pull request description:\n\n${forPrText}\n`);
      }
      if (!applied.ok) {
        if (ctx.opts.output === 'json') ctx.out.print({ applied: printed });
        throw new CLIError(
          applied.failed?.length
            ? 'Nothing was saved (see above). The agent has been told and follows up in the conversation: testsprite status --wait'
            : `Could not apply it: ${applied.message ?? 'see above'}.`,
          1,
          'APPLY_FAILED',
        );
      }
      if (applied.run && flags.wait !== false) {
        await handOverRun(ctx, projectId, id, now.lastSeq, printed, applied.run.runId, {
          steps: flags.steps as boolean | undefined,
          timeoutMs:
            deadlineMs === null
              ? null
              : Math.max(0, deadlineMs - ((deps.now ?? Date.now)() - startedAt)),
        });
        return;
      }
      const saved = applied.tests ?? [];
      const run: NextStep[] = saved.length
        ? [
            {
              command: `testsprite run ${saved.join(' ')} --wait`,
              why: 'run what it saved; add --local <port> for an app on this machine',
            },
          ]
        : [];
      await finishTurn(
        ctx,
        projectId,
        id,
        now.lastSeq,
        { ...flags, deadlineMs },
        { applied: printed, ...(forPr ? { prSummary: forPr } : {}) },
        run,
      );
    });
}

/**
 * The agent hears that a run it started has finished only when someone next
 * writes. Wait for the run here and tell it, so one `apply` goes from "run
 * these" to the agent's read of the results, within the one --timeout.
 */
/**
 * What a secret card asks for, read before anything is sent: a card applied without it is
 * refused and keeps waiting, so the secret is piped in or typed by a person, never a flag.
 */
/** A card's summary inside a sentence: "The password of staging" reads "the password of staging". */
const midSentence = (text: string): string =>
  /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;

async function secretFor(
  ctx: Context,
  now: Conversation,
  card: string,
  fromStdin: boolean,
): Promise<string | undefined> {
  const proposal = now.proposal?.id === card ? now.proposal : null;
  if (proposal?.kind !== 'secret') {
    if (fromStdin) {
      throw new CLIError(
        '--secret-stdin is for a card that asks for a secret; this card does not.',
        5,
        'VALIDATION_ERROR',
      );
    }
    return undefined;
  }
  if (ctx.opts.dryRun) return undefined;
  let value: string;
  if (fromStdin) {
    value = await (ctx.deps.readStdin ?? readPipedStdin)();
  } else if (ctx.interactive) {
    const ask = ctx.deps.promptSecret ?? ((q: string) => promptSecret(q));
    value = await ask(`Type ${terminalSafeLine(midSentence(proposal.summary))}: `);
  } else {
    throw new CLIError(
      `This card asks for ${midSentence(proposal.summary)}, typed by a person. Run \`testsprite apply\` in a terminal, pipe it to \`testsprite apply --secret-stdin\`, or apply it in the portal: ${now.url}`,
      5,
      'VALIDATION_ERROR',
    );
  }
  if (!value.trim()) {
    throw new CLIError(
      'Nothing was entered, so nothing was applied; the card still waits.',
      5,
      'VALIDATION_ERROR',
    );
  }
  return value;
}

/** What is piped in, without the newline `echo` ends it with. A terminal is not a pipe. */
async function readPipedStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CLIError(
      '--secret-stdin reads what is piped in. In a terminal, leave it out and type the secret when asked.',
      5,
      'VALIDATION_ERROR',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

async function handOverRun(
  ctx: Context,
  projectId: string,
  id: string,
  afterSeq: number,
  /** What `apply` did, as it is printed. */
  applied: ApplyResult,
  /** The launch of the run to wait for. */
  runId: string,
  { steps, timeoutMs }: { steps: boolean | undefined; timeoutMs: number | null },
): Promise<void> {
  const clock = ctx.deps.now ?? Date.now;
  const end = timeoutMs === null ? null : clock() + timeoutMs;
  const left = () => (end === null ? null : Math.max(0, end - clock()));
  const ack = await follow(ctx, projectId, id, afterSeq, left());
  if (ack.timedOut || ack.conversation.state !== 'replied') {
    settle(ctx, ack, steps, { applied }, []);
    return;
  }
  ctx.stderr(`Waiting for run ${terminalSafeLine(runId)} to finish…`);
  let snapshot: RunWaitSnapshot | undefined;
  let outcome: RunWaitOutcome;
  const printPartial = () =>
    print(
      ctx,
      ack.conversation,
      ack.events,
      steps,
      {
        applied,
        run: {
          runId,
          ...(snapshot ? { status: snapshot.run.status, cancelled: snapshot.run.cancelled } : {}),
          ...(outcome?.timedOut ? { timedOut: true } : {}),
        },
        results: snapshot?.results ?? [],
      },
      [
        {
          command: `testsprite run wait ${runId}`,
          why: 'resume waiting for this execution before handing its results to the agent',
        },
      ],
    );
  try {
    outcome = await waitForRun(ctx.client, runId, {
      deadline: Date.now() + (left() ?? Infinity),
      shutdown: globalShutdown,
      sleep: ctx.deps.sleep,
      onRead: value => {
        snapshot = value;
      },
    });
  } catch (error) {
    printPartial();
    throw error;
  }
  const failure = resolveRunWaitFailure([outcome], { timeoutSeconds: (timeoutMs ?? 0) / 1000 });
  if (outcome.timedOut || outcome.error) {
    printPartial();
    throw failure;
  }
  // The agent reads results itself; report generation is not a prerequisite for handoff.
  const finished = outcome.run?.cancelled
    ? `The run ${runId} was cancelled. Go through its results.`
    : `The run ${runId} has finished. Go through its results.`;
  await ctx.api.send(projectId, id, { text: finished });
  const result = await follow(ctx, projectId, id, ack.conversation.lastSeq, left());
  settle(ctx, { ...result, events: [...ack.events, ...result.events] }, steps, { applied }, []);
  if (failure) throw failure;
}

export function createRejectCommand(deps: ConversationDeps = {}): Command {
  const cmd = new Command('reject')
    .summary('Turn down what the agent proposed; it reads your reason and revises')
    .argument('[reason...]', 'what to change')
    .option('--card <id>', CARD_HELP);
  addTarget(cmd);
  addWaitOptions(cmd);
  return cmd
    .option('--steps', 'show each proposed test step by step')
    .addHelpText(
      'after',
      '\nExample:\n  testsprite reject "split the coupon test: one for the limit, one for expired codes"\n' +
        EXIT_CODES +
        GLOBAL_OPTS_HINT,
    )
    .action(async (words: string[], flags, command: Command) => {
      const ctx = context(command, deps);
      const deadlineMs = timeoutMs(ctx, flags);
      const { projectId, id } = await current(ctx, flags);
      const now = await ctx.api.get(projectId, id);
      const card = cardToDecide(ctx, now, flags.card as string | undefined);
      if (!card) {
        throw new CLIError(
          `Nothing is waiting to be rejected: the conversation is ${now.state}. To tell the agent something, use \`testsprite reply\`.`,
          6,
          'CONFLICT',
        );
      }
      const reason = words.join(' ').trim();
      const { rejected } = await ctx.api.reject(projectId, id, card, reason || undefined);
      ctx.stderr(`Rejected: ${terminalSafeLine(rejected)}`);
      await finishTurn(ctx, projectId, id, now.lastSeq, { ...flags, deadlineMs });
    });
}

export function createStopCommand(deps: ConversationDeps = {}): Command {
  const cmd = new Command('stop').summary('Stop the agent where it is');
  addTarget(cmd);
  return cmd.addHelpText('after', GLOBAL_OPTS_HINT).action(async (flags, command: Command) => {
    const ctx = context(command, deps);
    const { projectId, id } = await current(ctx, flags);
    const { stopped } = await ctx.api.stop(projectId, id);
    ctx.out.print({ stopped: id, ...(stopped === false ? { nothingToStop: true } : {}) }, () =>
      stopped === false
        ? 'Nothing to stop: the agent was not working.'
        : 'Stopped. `testsprite reply "<message>"` picks it up again.',
    );
  });
}

export function createDiscardCommand(deps: ConversationDeps = {}): Command {
  const cmd = new Command('discard').summary(
    "Drop the conversation's task: stop the agent, turn down what waits, release what it holds",
  );
  addTarget(cmd);
  return cmd
    .description(
      'Stop the agent, turn down a card waiting on you, and put back what the conversation changed ' +
        'in the project and never saved, so other conversations are not held by it. Nothing saved ' +
        'to the suite is touched. The conversation stays readable, and reads as discarded until a ' +
        'reply picks it up again.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (flags, command: Command) => {
      const ctx = context(command, deps);
      const { projectId, id } = await current(ctx, flags);
      const { released } = await ctx.api.discard(projectId, id);
      ctx.out.print({ discarded: id, released }, () =>
        released.length
          ? `Discarded. Put back ${released.length} unsaved ${released.length === 1 ? 'file' : 'files'}: ${terminalSafeLine(released.join(', '))}`
          : 'Discarded. It held nothing unsaved.',
      );
    });
}

export function createConversationCommands(deps: ConversationDeps = {}): Command[] {
  return [
    createPlanCommand(deps),
    createApplyCommand(deps),
    createRejectCommand(deps),
    createReplyCommand(deps),
    createStatusCommand(deps),
    createDiscardCommand(deps),
    createStopCommand(deps),
  ];
}
