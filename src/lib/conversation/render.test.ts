import { describe, expect, it } from 'vitest';
import { Output } from '../output.js';
import {
  nextSteps,
  prSummary,
  renderApplied,
  renderConversation,
  renderEvent,
  renderProposal,
  waitingNotes,
} from './render.js';
import type { Conversation, Proposal, RunEnvironment } from './types.js';

const plan: Proposal = {
  id: 'card-1',
  kind: 'plan',
  summary: '1 new test, 1 removed',
  plan: {
    added: [
      {
        ref: '1',
        useCase: 'Checkout',
        title: 'Apply two coupons',
        priority: 'High',
        description: 'Expected from the PRD.',
        steps: [
          { type: 'action', description: 'Apply SAVE10' },
          { type: 'assertion', description: 'The total drops by 10%' },
        ],
      },
    ],
    changed: [],
    removed: [{ ref: 'CHK-009' }],
  },
};

function conversation(over: Partial<Conversation>): Conversation {
  return {
    id: 'c1',
    projectId: 'p1',
    title: null,
    url: 'https://portal/c1',
    state: 'replied',
    model: 'claude-opus-5-5',
    lastSeq: 3,
    events: [],
    proposal: null,
    reply: 'Done.',
    ...over,
  };
}

describe('renderEvent', () => {
  it('shows what the agent does and says, not what the user typed', () => {
    const at = '2026-01-01T00:00:00.000Z';
    expect(renderEvent({ seq: 1, at, kind: 'activity', text: 'Opening a browser' })).toBe(
      '  · Opening a browser',
    );
    expect(renderEvent({ seq: 2, at, kind: 'message', from: 'agent', text: 'Hi\nthere' })).toBe(
      '\n  Hi\n  there\n',
    );
    expect(renderEvent({ seq: 3, at, kind: 'message', from: 'user', text: 'go' })).toBeNull();
  });
});

describe('renderProposal', () => {
  it('lists each test with the ref apply takes, and steps only when asked', () => {
    const brief = renderProposal(plan, false).join('\n');
    expect(brief).toContain('1        Checkout · Apply two coupons  [High]');
    expect(brief).toContain('CHK-009');
    expect(brief).not.toContain('Check: The total drops by 10%');
    expect(brief).toContain('Add --steps');
    expect(renderProposal(plan, true).join('\n')).toContain('2. Check: The total drops by 10%');
  });

  it("leads with the agent's reason for the change", () => {
    const lines = renderProposal(
      { ...plan, message: 'Cover the coupon rules from the PRD' },
      false,
    );
    expect(lines.slice(0, 2)).toEqual([
      'Proposed: 1 new test, 1 removed',
      '  Cover the coupon rules from the PRD',
    ]);
  });

  it('says a secret is typed by a person or piped in, never passed as a flag', () => {
    const lines = renderProposal(
      {
        id: 'card-1',
        kind: 'secret',
        summary: 'the password for qa on staging.example.com',
        secret: { environment: 'staging', field: 'password' },
      },
      false,
    ).join('\n');
    expect(lines).toContain('Proposed: the password for qa on staging.example.com');
    expect(lines).toContain(
      'For the staging environment. A person types it, or it is piped in with --secret-stdin',
    );
  });
});

const questions: Proposal = {
  id: 'card-2',
  kind: 'question',
  summary: '2 questions',
  questions: [
    {
      question: 'What should I work on next?',
      header: 'Next',
      options: [
        { label: 'Round 5', description: 'Tunnels, test lists and schedules.' },
        { label: 'Write routes', description: '' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which of these are bugs?',
      header: 'Bugs',
      options: [
        { label: 'The 204', description: 'A random id answers 204.' },
        { label: 'The 400', description: 'ttlSeconds above the cap.' },
      ],
      multiSelect: true,
    },
  ],
};

describe('renderProposal', () => {
  it('says where a run goes, and that --env picks another environment', () => {
    const card = (environment: RunEnvironment | undefined) =>
      renderProposal(
        { id: 'card-1', kind: 'run', summary: 'Run 1 test', run: { tests: ['k1'], environment } },
        false,
      ).join('\n');
    expect(card({ id: 'e2', name: 'staging', isDefault: false })).toContain(
      '  Tests: k1\n  On the staging environment; --env <name> picks another.',
    );
    expect(card({ id: 'e1', name: 'default', isDefault: true })).toContain(
      "  On the default environment (the project's default); --env <name> picks another.",
    );
    expect(card(undefined)).not.toContain('environment');
  });

  it('numbers the questions and letters their options', () => {
    expect(renderProposal(questions, false).join('\n')).toBe(
      [
        'Proposed: 2 questions',
        '',
        '  1. Next — What should I work on next?',
        '     a) Round 5 — Tunnels, test lists and schedules.',
        '     b) Write routes',
        '',
        '  2. Bugs — Which of these are bugs?  (pick several, comma-separated)',
        '     a) The 204 — A random id answers 204.',
        '     b) The 400 — ttlSeconds above the cap.',
      ].join('\n'),
    );
  });
});

describe('nextSteps', () => {
  it('shows how to answer a question card, one --answer per question', () => {
    expect(
      nextSteps(conversation({ state: 'proposed', proposal: questions })).map(s => s.command),
    ).toEqual([
      'testsprite apply --answer 1=a --answer 2=a,b',
      'testsprite reject "<what to change>"',
    ]);
  });

  it('offers apply, a partial apply and reject for a plan', () => {
    expect(
      nextSteps(conversation({ state: 'proposed', proposal: plan })).map(s => s.command),
    ).toEqual([
      'testsprite apply',
      'testsprite apply --exclude CHK-009',
      'testsprite reject "<what to change>"',
    ]);
  });

  it('warns that applying a run spends credits', () => {
    const steps = nextSteps(
      conversation({
        state: 'proposed',
        proposal: { id: 'card-1', kind: 'run', summary: 'Run every test', run: { tests: [] } },
      }),
    );
    expect(steps[0]).toEqual({
      command: 'testsprite apply',
      why: 'start the run (it uses credits)',
    });
    expect(steps.map(s => s.command)).not.toContain('testsprite apply --env <name>');
  });

  it('offers another environment for a run whose card names one', () => {
    const steps = nextSteps(
      conversation({
        state: 'proposed',
        proposal: {
          id: 'card-1',
          kind: 'run',
          summary: 'Run 1 test',
          run: { tests: ['k1'], environment: { id: 'e2', name: 'staging', isDefault: false } },
        },
      }),
    );
    expect(steps.map(s => s.command)).toEqual([
      'testsprite apply',
      'testsprite apply --env <name>',
      'testsprite reject "<what to change>"',
    ]);
  });

  it.each([
    ['working', 'testsprite status --wait'],
    ['replied', 'testsprite reply "<message>"'],
    ['ended', 'testsprite plan "<what to test>"'],
  ] as const)('%s → %s', (state, command) => {
    expect(nextSteps(conversation({ state }))[0]?.command).toBe(command);
  });

  it('offers to pick a discarded conversation up again, or to start a new one', () => {
    expect(nextSteps(conversation({ state: 'stopped', stopReason: 'discarded' }))).toEqual([
      { command: 'testsprite reply "<message>"', why: 'pick it up again' },
      { command: 'testsprite plan "<what to test>"', why: 'start a new conversation' },
    ]);
  });

  it('points at the balance when the credits ran out', () => {
    expect(
      nextSteps(conversation({ state: 'stopped', stopReason: 'out_of_credits' }))[0]?.command,
    ).toBe('testsprite usage');
  });
});

describe('renderConversation', () => {
  it('says why the agent stopped, and does not repeat a reply already shown', () => {
    const text = renderConversation(
      conversation({ state: 'stopped', stopReason: 'budget_reached', reply: 'Half done.' }),
      { replyShown: true },
    );
    expect(text).toContain(
      'The agent stopped before it finished: it reached the spending limit for one conversation.',
    );
    expect(text).not.toContain('Half done.');
    expect(text).toContain('https://portal/c1');
  });

  it.each([
    ['discarded', 'The agent stopped before it finished: its task was discarded.'],
    ['out_of_credits', 'The agent stopped before it finished: the workspace ran out of credits.'],
  ])('says the conversation stopped because %s', (stopReason, headline) => {
    const text = renderConversation(conversation({ state: 'stopped', stopReason, reply: null }));
    expect(text.split('\n')[0]).toBe(headline);
  });

  it('says so when the agent ended its turn without a message', () => {
    const text = renderConversation(conversation({ state: 'replied', reply: null }));
    expect(text.split('\n')[0]).toBe('The agent ended its turn without a message.');
  });
});

describe('prSummary', () => {
  it('lists what the plan saved, for a pull request description', () => {
    const text = prSummary(
      {
        applied: '2 new tests',
        ok: true,
        saved: [
          { path: '/test-cases/a.md', detail: 'created CHK-011', title: 'Apply two coupons' },
          { path: '/test-cases/b.md', detail: 'deleted CHK-009' },
        ],
      },
      'https://portal/c1',
    );
    expect(text).toBe(
      [
        '### TestSprite',
        'Tests for this change in the regression suite:',
        '- Added `CHK-011` Apply two coupons',
        '- Removed `CHK-009`',
        '',
        'Written by the TestSprite agent: https://portal/c1',
      ].join('\n'),
    );
  });

  it('leaves project setup out of a pull request', () => {
    expect(
      prSummary(
        {
          applied: 'Save 1 schedule change',
          ok: true,
          saved: [{ path: '/schedules/nightly.md', detail: 'created schedule Nightly' }],
        },
        'u',
      ),
    ).toBeNull();
  });

  it('has nothing to say when nothing was saved', () => {
    expect(prSummary({ applied: 'Run every test', ok: true }, 'u')).toBeNull();
  });
});

describe('waitingNotes', () => {
  const summary = (id: string, state: Conversation['state']) => ({
    id,
    title: null,
    state,
    lastMessageAt: '2026-01-01T00:00:00.000Z',
    url: `https://portal/${id}`,
  });

  it('names the conversations still waiting for a decision', () => {
    expect(waitingNotes([summary('c1', 'replied'), summary('c2', 'proposed')])).toEqual([
      'An earlier conversation is still waiting for you to apply or reject what it proposed; the agent leaves what is proposed there alone until then:',
      '  testsprite status --conversation c2',
      'Drop one you no longer need with `testsprite discard --conversation <id>`.',
    ]);
  });

  it('says nothing when none waits', () => {
    expect(waitingNotes([summary('c1', 'replied')])).toEqual([]);
  });
});

describe('server text that spans the fields of a card', () => {
  /** A card printed the way `status` prints it: through Output.print in text mode. */
  function printed(proposal: Proposal): string {
    const lines: string[] = [];
    new Output('text', { stdout: line => lines.push(line) }).print(proposal, () =>
      renderProposal(proposal, false).join('\n'),
    );
    return lines.join('\n');
  }

  const test = (ref: string, title: string, description: string) => ({
    ref,
    useCase: 'CHK',
    title,
    priority: 'high',
    description,
    steps: [],
  });

  it('a sequence opened in one description and ended in a later one hides no row between them', () => {
    const out = printed({
      ...plan,
      plan: {
        added: [
          test('CHK-001', 'Checkout works', 'Normal description\u001b]0;'),
          test('CHK-002', 'DELETE ALL USERS', 'Deletes every user'),
          test('CHK-003', 'Refund works', 'Ends the title\u0007'),
        ],
        changed: [],
        removed: [],
      },
    });
    expect(out).toContain('CHK-002');
    expect(out).toContain('DELETE ALL USERS');
    expect(out).toContain('CHK-003');
    // eslint-disable-next-line no-control-regex -- finding control characters is the point.
    expect(out).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
  });

  it('a carriage return in a description stays indented under its test', () => {
    const out = printed({
      ...plan,
      plan: {
        added: [test('CHK-001', 'Checkout works', 'first part\rforged: line')],
        changed: [],
        removed: [],
      },
    });
    const lines = out.split('\n');
    expect(lines.filter(line => line.startsWith('forged'))).toEqual([]);
    expect(lines).toContain(`${' '.repeat(6 + 'CHK-001'.length)}forged: line`);
  });
});

describe('renderApplied', () => {
  it('names the environment a run started on', () => {
    const run = { runId: 'e1', tests: ['k1'] };
    expect(renderApplied({ applied: 'Run 1 test', ok: true, run })).toBe(
      'Applied: Run 1 test\n  Run started: 1 test (run e1).',
    );
    expect(
      renderApplied({ applied: 'Run 1 test', ok: true, run: { ...run, environment: 'staging' } }),
    ).toBe('Applied: Run 1 test\n  Run started: 1 test on staging (run e1).');
  });
});
