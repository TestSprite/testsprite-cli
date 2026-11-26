import { terminalSafe, terminalSafeLine } from '../terminal-text.js';
import { optionLetter } from './answers.js';
import type {
  ApplyResult,
  Conversation,
  ConversationEvent,
  ConversationSummary,
  PlanTest,
  Proposal,
  Question,
} from './types.js';

export interface NextStep {
  command: string;
  why: string;
}

/** One line of progress on stderr while the agent works; the user's own messages are not echoed back. */
export function renderEvent(event: ConversationEvent): string | null {
  switch (event.kind) {
    case 'activity':
      return `  · ${terminalSafeLine(event.text)}`;
    case 'error':
      return `  ! ${terminalSafeLine(event.text)}`;
    case 'message':
      return event.from === 'agent' ? `\n${indent(event.text, '  ')}\n` : null;
  }
}

const HEADLINE: Record<Conversation['state'], string> = {
  working: 'The agent is still working.',
  proposed: 'The agent is waiting for you to apply or reject what it proposed.',
  replied: 'The agent replied.',
  stopped: 'The agent stopped before it finished.',
  ended: 'This conversation has ended.',
};

const STOP_REASON: Record<string, string> = {
  stopped_by_user: 'it was asked to stop',
  discarded: 'its task was discarded',
  out_of_credits: 'the workspace ran out of credits',
  budget_reached: 'it reached the spending limit for one conversation',
  retries_exhausted: 'it hit errors it could not get past',
  refusal: 'it declined the request',
};

/**
 * What to do next, for people and coding agents alike; `--output json`
 * carries the same list as `next`.
 */
export function nextSteps(conversation: Conversation): NextStep[] {
  const steps: NextStep[] = [];
  switch (conversation.state) {
    case 'working':
      steps.push({ command: 'testsprite status --wait', why: 'follow it until it needs you' });
      steps.push({ command: 'testsprite stop', why: 'stop it where it is' });
      break;
    case 'proposed': {
      const proposal = conversation.proposal;
      if (proposal?.kind === 'plan') {
        steps.push({ command: 'testsprite apply', why: 'save the plan to the test suite' });
        const refs = planRefList(proposal);
        if (refs.length > 1) {
          steps.push({
            command: `testsprite apply --exclude ${refs[refs.length - 1]}`,
            why: 'save all of it but the tests you name',
          });
        }
      } else if (proposal?.kind === 'run') {
        steps.push({ command: 'testsprite apply', why: 'start the run (it uses credits)' });
        if (proposal.run?.environment) {
          steps.push({
            command: 'testsprite apply --env <name>',
            why: "start it on another of the project's environments",
          });
        }
      } else if (proposal?.kind === 'secret') {
        steps.push({
          command: 'testsprite apply',
          why: 'a person types it in a terminal, or pipe it with --secret-stdin, or apply it in the portal',
        });
      } else if (proposal?.kind === 'question' && proposal.questions?.length) {
        steps.push({
          command: `testsprite apply ${proposal.questions
            .map((q, i) => `--answer ${i + 1}=${q.multiSelect ? 'a,b' : 'a'}`)
            .join(' ')}`,
          why: 'answer each question by letter; your own words in quotes: --answer 1="…"',
        });
      } else {
        steps.push({ command: 'testsprite apply', why: 'go ahead with it' });
      }
      steps.push({ command: 'testsprite reject "<what to change>"', why: 'the agent revises it' });
      break;
    }
    case 'replied':
      steps.push({
        command: 'testsprite reply "<message>"',
        why: 'answer it, or ask for more in the same conversation',
      });
      break;
    case 'stopped':
      if (conversation.stopReason === 'out_of_credits') {
        steps.push({ command: 'testsprite usage', why: "check the workspace's balance" });
      }
      steps.push({
        command: 'testsprite reply "<message>"',
        why: conversation.stopReason === 'discarded' ? 'pick it up again' : 'ask it to go on',
      });
      if (conversation.stopReason === 'discarded') {
        steps.push({
          command: 'testsprite plan "<what to test>"',
          why: 'start a new conversation',
        });
      }
      break;
    case 'ended':
      steps.push({ command: 'testsprite plan "<what to test>"', why: 'start a new conversation' });
      break;
  }
  return steps;
}

function planRefList(proposal: Proposal): string[] {
  const plan = proposal.plan;
  if (!plan) return [];
  return [...plan.added, ...plan.changed, ...plan.removed].map(t => t.ref);
}

/** The conversation as it stands, for the terminal. */
export function renderConversation(
  conversation: Conversation,
  options: { steps?: boolean; replyShown?: boolean; next?: NextStep[] } = {},
): string {
  const lines: string[] = [];
  const reason = conversation.stopReason ? STOP_REASON[conversation.stopReason] : undefined;
  const silent = conversation.state === 'replied' && !conversation.reply && !options.replyShown;
  lines.push(
    reason
      ? `${HEADLINE[conversation.state].slice(0, -1)}: ${reason}.`
      : silent
        ? 'The agent ended its turn without a message.'
        : HEADLINE[conversation.state],
  );
  if (conversation.reply && !options.replyShown) {
    lines.push('', indent(conversation.reply, '  '));
  }
  if (conversation.proposal) {
    lines.push('', ...renderProposal(conversation.proposal, options.steps ?? false));
  }
  lines.push('', ...renderNext(options.next ?? nextSteps(conversation)));
  lines.push(`  ${'Open in the portal'.padEnd(NEXT_WIDTH)}${terminalSafeLine(conversation.url)}`);
  return lines.join('\n');
}

const NEXT_WIDTH = 40;

function renderNext(steps: NextStep[]): string[] {
  return [
    'Next:',
    ...steps.flatMap(s => {
      // A command can name a server ref (`apply --exclude <ref>`): one line, terminal-safe.
      const command = terminalSafeLine(s.command);
      return command.length < NEXT_WIDTH
        ? [`  ${command.padEnd(NEXT_WIDTH)}${s.why}`]
        : [`  ${command}`, `  ${' '.repeat(NEXT_WIDTH)}${s.why}`];
    }),
  ];
}

export function renderProposal(proposal: Proposal, showSteps: boolean): string[] {
  const lines = [`Proposed: ${terminalSafeLine(proposal.summary)}`];
  if (proposal.message) lines.push(indent(proposal.message, '  '));
  const plan = proposal.plan;
  if (plan) {
    const width = Math.max(...planRefList(proposal).map(ref => ref.length), 1);
    const under = ' '.repeat(6 + width);
    if (plan.added.length) {
      lines.push('', '  New tests');
      for (const test of plan.added) lines.push(...renderTest(test, showSteps, width));
    }
    if (plan.changed.length) {
      lines.push('', '  Changed tests');
      for (const change of plan.changed) {
        const what = [
          change.useCase && `moves to ${terminalSafeLine(change.useCase)}`,
          change.priority && `priority ${terminalSafeLine(change.priority)}`,
          change.description !== undefined && 'new description',
          change.steps && 'new steps',
        ].filter(Boolean);
        lines.push(
          `    ${terminalSafeLine(change.ref).padEnd(width)}  ${terminalSafeLine(change.title)}${what.length ? ` (${what.join(', ')})` : ''}`,
        );
        if (change.description) lines.push(indent(change.description, under));
        if (showSteps && change.steps) lines.push(...renderSteps(change.steps, under));
      }
    }
    if (plan.removed.length) {
      lines.push('', '  Removed tests', ...plan.removed.map(r => `    ${terminalSafeLine(r.ref)}`));
    }
    if (!showSteps && [...plan.added, ...plan.changed].some(t => t.steps?.length)) {
      lines.push('', '  Add --steps to see each test step by step.');
    }
    if (plan.environment) {
      lines.push(
        '',
        `  Explored on the ${terminalSafeLine(plan.environment.name)} environment${plan.environment.isDefault ? " (the project's default)" : ''}.`,
      );
    }
  }
  for (const change of proposal.changes ?? []) {
    lines.push(
      `  ${terminalSafeLine(change.op).padEnd(7)} ${terminalSafeLine(change.name)}${change.detail ? `  ${terminalSafeLine(change.detail)}` : ''}`,
    );
  }
  if (proposal.secret) {
    lines.push(
      '',
      `  For the ${terminalSafeLine(proposal.secret.environment)} environment. A person types it, or it is piped in with --secret-stdin; it is never passed as a flag.`,
    );
  }
  if (proposal.run) {
    lines.push(
      proposal.run.tests.length
        ? `  Tests: ${terminalSafeLine(proposal.run.tests.join(', '))}`
        : '  Every test in the project',
    );
    const environment = proposal.run.environment;
    if (environment) {
      lines.push(
        `  On the ${terminalSafeLine(environment.name)} environment${environment.isDefault ? " (the project's default)" : ''}; --env <name> picks another.`,
      );
    }
  }
  if (proposal.questions?.length) lines.push(...renderQuestions(proposal.questions));
  if (proposal.problems?.length) {
    lines.push(
      '',
      "  Can't be saved as written:",
      ...proposal.problems.map(
        p => `    ${terminalSafeLine(p.path)}: ${terminalSafeLine(p.reason)}`,
      ),
    );
  }
  return lines;
}

function renderQuestions(questions: Question[]): string[] {
  const lines: string[] = [];
  questions.forEach((q, i) => {
    lines.push(
      '',
      `  ${i + 1}. ${terminalSafeLine(q.header)} — ${terminalSafeLine(q.question)}${q.multiSelect ? '  (pick several, comma-separated)' : ''}`,
    );
    q.options.forEach((o, j) => {
      lines.push(
        `     ${optionLetter(j)}) ${terminalSafeLine(o.label)}${o.description ? ` — ${terminalSafeLine(o.description)}` : ''}`,
      );
    });
  });
  return lines;
}

function renderTest(test: PlanTest, showSteps: boolean, width: number): string[] {
  const under = ' '.repeat(6 + width);
  const lines = [
    `    ${terminalSafeLine(test.ref).padEnd(width)}  ${terminalSafeLine(test.useCase)} · ${terminalSafeLine(test.title)}  [${terminalSafeLine(test.priority)}]`,
  ];
  if (test.description) lines.push(indent(test.description, under));
  if (showSteps) lines.push(...renderSteps(test.steps, under));
  return lines;
}

function renderSteps(steps: PlanTest['steps'], under: string): string[] {
  return steps.map(
    (step, i) =>
      `${under}${i + 1}. ${step.type === 'assertion' ? 'Check: ' : ''}${terminalSafeLine(step.description)}`,
  );
}

export function renderApplied(result: ApplyResult): string {
  const applied = terminalSafeLine(result.applied);
  const lines = [result.ok ? `Applied: ${applied}` : `Could not apply: ${applied}`];
  for (const saved of result.saved ?? []) lines.push(`  ✓ ${terminalSafeLine(saved.detail)}`);
  for (const failed of result.failed ?? [])
    lines.push(`  ✗ ${terminalSafeLine(failed.path)}: ${terminalSafeLine(failed.error)}`);
  if (result.run) {
    const where = result.run.environment ? ` on ${terminalSafeLine(result.run.environment)}` : '';
    lines.push(
      `  Run started: ${result.run.tests.length} ${result.run.tests.length === 1 ? 'test' : 'tests'}${where} (run ${terminalSafeLine(result.run.runId)}).`,
    );
  }
  if (result.message) lines.push(indent(result.message, '  '));
  return lines.join('\n');
}

/**
 * Earlier conversations still waiting for an apply or reject. The agent leaves
 * the tests such a proposal changes alone, so a new plan says so up front.
 */
export function waitingNotes(conversations: ConversationSummary[]): string[] {
  const waiting = conversations.filter(c => c.state === 'proposed');
  if (!waiting.length) return [];
  const shown = waiting
    .slice(0, 3)
    .map(c => `  testsprite status --conversation ${terminalSafeLine(c.id)}`);
  const who =
    waiting.length === 1
      ? 'An earlier conversation is still waiting for you to apply or reject what it proposed'
      : `${waiting.length} earlier conversations are still waiting for you to apply or reject what they proposed`;
  return [
    `${who}; the agent leaves what is proposed there alone until then:`,
    ...shown,
    ...(waiting.length > shown.length ? ['  testsprite status --list'] : []),
    'Drop one you no longer need with `testsprite discard --conversation <id>`.',
  ];
}

export function renderConversationList(conversations: ConversationSummary[]): string {
  if (!conversations.length) return 'No conversations with the agent on this project yet.';
  return conversations
    .map(
      c =>
        `${terminalSafeLine(c.id)}  ${terminalSafeLine(c.state).padEnd(8)}  ${terminalSafeLine(c.lastMessageAt.slice(0, 16).replace('T', ' '))}  ${terminalSafeLine(c.title ?? '(untitled)')}`,
    )
    .join('\n');
}

/**
 * Server text (a reply, a message, a description) placed under `prefix`. It is
 * made terminal-safe on its own, before it is split, so a sequence in it can
 * reach nothing the CLI wrote around it and a carriage return becomes a line
 * that is indented like the rest.
 */
function indent(text: string, prefix: string): string {
  return terminalSafe(text)
    .split('\n')
    .map(line => (line ? `${prefix}${line}` : line))
    .join('\n');
}

const PR_VERB: Record<string, string> = {
  created: 'Added',
  updated: 'Changed',
  deleted: 'Removed',
};

/**
 * The tests a plan saved, as a pull request's description lists them, so the
 * reviewers of a change see the tests that now guard it. `inLine` is applied
 * to each server value (an id, a title, the link): the terminal passes
 * `terminalSafeLine`, the JSON keeps the values as sent.
 */
export function prSummary(
  applied: ApplyResult,
  url: string,
  inLine: (value: string) => string = value => value,
): string | null {
  // Only tests belong in a pull request; an environment or schedule is project setup.
  const tests = (applied.saved ?? []).filter(saved => saved.path.startsWith('/test-cases/'));
  const rows = tests.flatMap(saved => {
    const [verb, id] = saved.detail.split(' ');
    const said = PR_VERB[verb ?? ''];
    if (!said || !id) return [];
    return [`- ${said} \`${inLine(id)}\`${saved.title ? ` ${inLine(saved.title)}` : ''}`];
  });
  if (!rows.length) return null;
  return [
    '### TestSprite',
    'Tests for this change in the regression suite:',
    ...rows,
    '',
    `Written by the TestSprite agent: ${inLine(url)}`,
  ].join('\n');
}
