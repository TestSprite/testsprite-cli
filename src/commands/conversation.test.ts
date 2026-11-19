import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeProfile } from '../lib/credentials.js';
import type { FetchImpl } from '../lib/http.js';
import type { Git } from '../lib/conversation/change.js';
import type { Conversation } from '../lib/conversation/types.js';
import { resultLine } from '../../test/helpers/result-list.js';
import { runListing } from '../../test/helpers/project-run.js';
import { InterruptError } from '../lib/errors.js';
import { createConversationCommands, type ConversationDeps } from './conversation.js';

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

const PLAN: Conversation['proposal'] = {
  id: 'card-1',
  kind: 'plan',
  summary: '1 new test',
  plan: {
    added: [
      {
        ref: '1',
        useCase: 'Checkout',
        title: 'Apply a coupon',
        priority: 'High',
        description: 'From the PRD.',
        steps: [],
      },
    ],
    changed: [],
    removed: [],
  },
};

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    projectId: 'p1',
    title: null,
    url: 'https://portal/p1/agent/c1',
    state: 'replied',
    model: 'claude-opus-5-5',
    lastSeq: 7,
    events: [],
    proposal: null,
    reply: 'Done.',
    ...over,
  };
}

/** A backend that answers each route with what the test hands it. */
function backend(routes: Record<string, (body: unknown) => unknown>) {
  const calls: Call[] = [];
  const fetchImpl: FetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url instanceof Request ? url.url : String(url));
    const path = pathname.replace(/^\/api\/cli\/v1/, '');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body;
    calls.push({ method, path, body, headers: (init.headers ?? {}) as Record<string, string> });
    const handler = routes[`${method} ${path}`];
    if (!handler) {
      return Response.json(
        { statusCode: 404, error: 'Not Found', message: `Cannot ${method} ${path}` },
        { status: 404 },
      );
    }
    return new Response(JSON.stringify(handler(body) ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

const noRepo: Git = () => ({ ok: false, stdout: '' });

let deps: Omit<ConversationDeps, 'fetchImpl'>;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ts-conversation-'));
  const credentialsPath = join(dir, 'credentials');
  writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
  stdout = [];
  stderr = [];
  deps = {
    env: {},
    credentialsPath,
    cwd: dir,
    git: noRepo,
    interactive: false,
    stdout: line => stdout.push(line),
    stderr: line => stderr.push(line),
    sleep: async () => {},
  };
});

async function run(argv: string[], fetchImpl: ConversationDeps['fetchImpl']): Promise<void> {
  const program = new Command()
    .exitOverride()
    .option('--output <mode>', '', 'text')
    .option('--profile <name>')
    .option('--endpoint-url <url>')
    .option('--dry-run')
    .option('--debug')
    .option('--verbose')
    .option('--request-timeout <seconds>');
  for (const command of createConversationCommands({ ...deps, fetchImpl })) {
    program.addCommand(command.exitOverride());
  }
  await program.parseAsync(['node', 'testsprite', ...argv]);
}

describe('testsprite plan', () => {
  it('starts a conversation, tells the agent a coding agent is calling, and follows it', async () => {
    const { calls, fetchImpl } = backend({
      'GET /projects/p1/env': () => ({
        environments: [
          {
            name: 'default',
            url: 'https://shop.example.com',
            isDefault: true,
            authMode: 'manual',
            hasCredentials: false,
          },
        ],
      }),
      'GET /projects/p1/conversations': () => ({
        conversations: [
          {
            id: 'c0',
            title: 'older',
            state: 'proposed',
            lastMessageAt: '2026-01-01T00:00:00.000Z',
            url: 'https://portal/c0',
          },
        ],
      }),
      'POST /projects/p1/conversations': () => ({ id: 'c1', url: 'https://portal/c1', model: 'm' }),
      'POST /projects/p1/conversations/c1/messages': () => ({ seq: 1 }),
      'GET /projects/p1/conversations/c1': () =>
        conversation({
          state: 'proposed',
          proposal: PLAN,
          events: [{ seq: 3, at: '', kind: 'activity', text: 'Opening a browser' }],
        }),
    });
    await run(['plan', 'cover', 'coupons', '--project', 'p1'], fetchImpl);

    expect(
      calls.find(c => c.method === 'POST' && c.path === '/projects/p1/conversations')!.body,
    ).toEqual({ title: 'cover coupons' });
    const send = calls.find(c => c.path.endsWith('/messages'))!;
    expect(send.body).toEqual({ text: 'cover coupons', brief: { caller: 'agent' } });
    expect(send.headers['idempotency-key']).toBeTruthy();
    expect(calls.filter(c => c.method === 'GET').map(c => c.path)).toEqual([
      '/projects/p1/env',
      '/projects/p1/conversations',
      '/projects/p1/conversations/c1',
    ]);
    expect(stderr).toContain('  · Opening a browser');
    expect(stderr.join('\n')).toContain('signs in by hand (single sign-on)');
    expect(stderr).toContain('  testsprite status --conversation c0');
    const out = stdout.join('\n');
    expect(out).toContain('Proposed: 1 new test');
    expect(out).toContain('testsprite apply');
  });

  it('refuses a bad --timeout before starting anything', async () => {
    const { calls, fetchImpl } = backend({});
    await expect(
      run(['plan', 'x', '--project', 'p1', '--timeout', 'soon'], fetchImpl),
    ).rejects.toThrow(/--timeout must be a positive number/);
    expect(calls).toHaveLength(0);
  });

  it('exits 7 when the agent is still working at the deadline', async () => {
    const { fetchImpl } = backend({
      'POST /projects/p1/conversations': () => ({ id: 'c1', url: 'u', model: 'm' }),
      'POST /projects/p1/conversations/c1/messages': () => ({ seq: 1 }),
      'GET /projects/p1/conversations/c1': () => conversation({ state: 'working', reply: null }),
    });
    let t = 0;
    deps.now = () => (t += 10_000);
    await expect(
      run(['plan', 'x', '--project', 'p1', '--timeout', '15'], fetchImpl),
    ).rejects.toMatchObject({ exitCode: 7 });
    expect(stdout.join('\n')).toContain('testsprite status --wait');
  });
});

describe('testsprite apply', () => {
  it('applies only what is named, then follows the agent', async () => {
    let reads = 0;
    const { calls, fetchImpl } = backend({
      'GET /projects/p1/conversations/c1': () =>
        reads++ === 0 ? conversation({ state: 'proposed', proposal: PLAN }) : conversation(),
      'POST /projects/p1/conversations/c1/apply': () => ({
        applied: '1 new test',
        ok: true,
        saved: [{ path: '/t.md', detail: 'created CHK-011' }],
        failed: [],
        tests: ['k11'],
      }),
    });
    await run(
      ['apply', '--exclude', '2,CHK-9', '--project', 'p1', '--conversation', 'c1'],
      fetchImpl,
    );
    const apply = calls.find(c => c.path.endsWith('/apply'))!;
    expect(apply.body).toEqual({ card: 'card-1', exclude: ['2', 'CHK-9'] });
    expect(apply.headers['idempotency-key']).toBeTruthy();
    expect(stderr.join('\n')).toContain('✓ created CHK-011');
    expect(stdout.join('\n')).toContain('The agent replied.');
    expect(stdout.join('\n')).toContain('testsprite run k11 --wait');
  });

  it('waits for a run it started, then hands the results to the agent', async () => {
    let reads = 0;
    let reports = 0;
    const { calls, fetchImpl } = backend({
      'GET /projects/p1/conversations/c1': () => {
        reads += 1;
        if (reads === 1) {
          return conversation({
            state: 'proposed',
            proposal: { id: 'card-1', kind: 'run', summary: 'Run 1 test', run: { tests: ['k1'] } },
          });
        }
        if (reads === 2) return conversation({ lastSeq: 5, reply: 'Started; write when it ends.' });
        return conversation({
          lastSeq: 9,
          reply: 'One real bug.',
          events: [{ seq: 9, at: '', kind: 'message', from: 'agent', text: 'One real bug.' }],
        });
      },
      'POST /projects/p1/conversations/c1/apply': () => ({
        applied: 'Run 1 test',
        ok: true,
        run: { runId: 'e1', tests: ['k1'] },
      }),
      'GET /results': () =>
        runListing({ runId: 'e1', projectId: 'p1', status: 'finished', cancelled: false }, []),
      'GET /tests/executions/e1/report': () =>
        reports++ === 0 ? { ready: false, retryAfterSeconds: 1 } : { ready: true },
      'POST /projects/p1/conversations/c1/messages': () => ({ seq: 6 }),
    });
    await run(['apply', '--project', 'p1', '--conversation', 'c1'], fetchImpl);
    const told = calls.find(c => c.path.endsWith('/messages'))!;
    expect(told.body).toEqual({ text: 'The run e1 has finished. Go through its results.' });
    expect(reports).toBe(0);
    expect(stderr.join('\n')).toContain('One real bug.');
    expect(stdout.join('\n')).toContain('The agent replied.');
  });

  // The backend names the launch of a run the agent started `executionId`;
  // `apply` prints it as the run's `runId`.
  describe('a run the proposal started', () => {
    const RUN_CARD = {
      id: 'card-1',
      kind: 'run' as const,
      summary: 'Run 1 test',
      run: { tests: ['k1'] },
    };
    const started = (
      ready = true,
      config: { listing?: () => unknown; afterApply?: () => void } = {},
    ) => {
      let reads = 0;
      return backend({
        'GET /projects/p1/conversations/c1': () =>
          reads++ === 0
            ? conversation({ state: 'proposed', proposal: RUN_CARD })
            : conversation({ lastSeq: 5 + reads, reply: 'One real bug.' }),
        'POST /projects/p1/conversations/c1/apply': () => {
          config.afterApply?.();
          return {
            applied: 'Run 1 test',
            ok: true,
            run: { runId: 'e1', tests: ['k1'] },
          };
        },
        'GET /results': () =>
          config.listing?.() ??
          runListing(
            {
              runId: 'e1',
              projectId: 'p1',
              status: ready ? 'finished' : 'running',
              cancelled: false,
            },
            [],
          ),
        'GET /tests/executions/e1/report': () => (ready ? { ready: true } : { ready: false }),
        'POST /projects/p1/conversations/c1/messages': () => ({ seq: 6 }),
      });
    };
    const APPLIED = { applied: 'Run 1 test', ok: true, run: { runId: 'e1', tests: ['k1'] } };

    it('apply prints run <runId> and JSON applied.run.runId', async () => {
      await run(['apply', '--project', 'p1', '--conversation', 'c1'], started().fetchImpl);
      expect(stderr).toContain('Applied: Run 1 test\n  Run started: 1 test (run e1).');
      expect(stderr).toContain('Waiting for run e1 to finish…');

      stdout.length = 0;
      stderr.length = 0;
      await run(
        ['apply', '--project', 'p1', '--conversation', 'c1', '--output', 'json'],
        started().fetchImpl,
      );
      expect(JSON.parse(stdout.join('\n')).applied).toEqual(APPLIED);
      expect([...stdout, ...stderr].join('\n')).not.toContain('executionId');
    });

    it('--no-wait prints the same applied.run.runId', async () => {
      await run(
        ['apply', '--project', 'p1', '--conversation', 'c1', '--no-wait', '--output', 'json'],
        started().fetchImpl,
      );
      expect(JSON.parse(stdout.join('\n')).applied).toEqual(APPLIED);
    });

    it('a run still going at the deadline: the partial names it the same way', async () => {
      vi.useFakeTimers();
      deps.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const pending = run(
        ['apply', '--project', 'p1', '--conversation', 'c1', '--timeout', '5', '--output', 'json'],
        started(false).fetchImpl,
      ).catch(error => error);
      await vi.advanceTimersByTimeAsync(7_001);
      expect((await pending).exitCode).toBe(7);
      vi.useRealTimers();
      const printed = JSON.parse(stdout.join('\n'));
      expect(printed.applied).toEqual(APPLIED);
      expect(printed.next[0].command).toBe('testsprite run wait e1');
      expect(stdout.join('\n')).not.toContain('executionId');
    });

    it('hands a terminal execution to the agent while its report remains pending', async () => {
      const h = started(false, {
        listing: () =>
          runListing({ runId: 'e1', projectId: 'p1', status: 'finished', cancelled: false }, []),
      });
      await run(
        ['apply', '--project', 'p1', '--conversation', 'c1', '--timeout', '1'],
        h.fetchImpl,
      );
      expect(h.calls.some(c => c.path.endsWith('/report'))).toBe(false);
      expect(h.calls.find(c => c.path.endsWith('/messages'))?.body).toEqual({
        text: 'The run e1 has finished. Go through its results.',
      });
    });

    it('waits through later integration membership before sending the handoff', async () => {
      let reads = 0;
      const h = started(true, {
        listing: () => {
          reads++;
          return runListing(
            {
              runId: 'e1',
              projectId: 'p1',
              status: reads < 3 ? 'running' : 'finished',
              cancelled: false,
            },
            [
              resultLine({ resultId: 'unit', runId: 'e1', testStatus: 'PASSED' }),
              ...(reads === 3
                ? [resultLine({ resultId: 'integration', runId: 'e1', testStatus: 'PASSED' })]
                : []),
            ],
          );
        },
      });
      await run(['apply', '--project', 'p1', '--conversation', 'c1'], h.fetchImpl);
      expect(reads).toBe(3);
      expect(h.calls.findIndex(c => c.path.endsWith('/messages'))).toBeGreaterThan(
        h.calls.map(c => c.path).lastIndexOf('/results'),
      );
    });

    it.each(['cancelled', 'failed'])('reports %s execution without a passing exit', async state => {
      const h = started(true, {
        listing: () =>
          runListing(
            { runId: 'e1', projectId: 'p1', status: 'finished', cancelled: state === 'cancelled' },
            [
              resultLine({
                resultId: 'unit',
                runId: 'e1',
                testStatus: state === 'failed' ? 'FAILED' : 'PASSED',
              }),
            ],
          ),
      });
      await expect(
        run(['apply', '--project', 'p1', '--conversation', 'c1'], h.fetchImpl),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(h.calls.find(c => c.path.endsWith('/messages'))?.body).toEqual({
        text:
          state === 'cancelled'
            ? 'The run e1 was cancelled. Go through its results.'
            : 'The run e1 has finished. Go through its results.',
      });
    });

    it('preserves an interrupt and applied run without sending a completed handoff', async () => {
      const interrupt = new InterruptError('SIGINT');
      deps.sleep = async () => {
        throw interrupt;
      };
      const h = started(false);
      await expect(
        run(['apply', '--project', 'p1', '--conversation', 'c1', '--output', 'json'], h.fetchImpl),
      ).rejects.toBe(interrupt);
      expect(JSON.parse(stdout.join('\n')).applied.run.runId).toBe('e1');
      expect(h.calls.some(c => c.path.endsWith('/messages'))).toBe(false);
    });

    it('keeps an interactive run wait unbounded until authoritative completion', async () => {
      vi.useFakeTimers();
      try {
        deps.interactive = true;
        deps.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        let reads = 0;
        const h = started(true, {
          listing: () =>
            runListing(
              {
                runId: 'e1',
                projectId: 'p1',
                status: ++reads < 3 ? 'running' : 'finished',
                cancelled: false,
              },
              [],
            ),
        });
        let ended = false;
        const pending = run(['apply', '--project', 'p1', '--conversation', 'c1'], h.fetchImpl).then(
          () => {
            ended = true;
          },
        );
        await vi.advanceTimersByTimeAsync(2000);
        expect(ended).toBe(false);
        await vi.advanceTimersByTimeAsync(4000);
        await pending;
        expect(reads).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses the remaining apply deadline', async () => {
      vi.useFakeTimers();
      try {
        deps.now = () => Date.now();
        deps.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const h = started(false, {
          afterApply: () => {
            vi.setSystemTime(Date.now() + 4000);
          },
        });
        let ended = false;
        const pending = run(
          [
            'apply',
            '--project',
            'p1',
            '--conversation',
            'c1',
            '--timeout',
            '5',
            '--output',
            'json',
          ],
          h.fetchImpl,
        )
          .catch(e => e)
          .then(e => {
            ended = true;
            return e;
          });
        await vi.advanceTimersByTimeAsync(3001);
        expect(ended).toBe(true);
        expect((await pending).exitCode).toBe(7);
        expect(h.calls.some(c => c.path.endsWith('/messages'))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('an apply that failed prints what the backend said, with no run', async () => {
      const { fetchImpl } = backend({
        'GET /projects/p1/conversations/c1': () =>
          conversation({ state: 'proposed', proposal: RUN_CARD }),
        'POST /projects/p1/conversations/c1/apply': () => ({
          applied: 'Run 1 test',
          ok: false,
          message: 'no credits left',
        }),
      });
      await expect(
        run(['apply', '--project', 'p1', '--conversation', 'c1', '--output', 'json'], fetchImpl),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(JSON.parse(stdout.join('\n'))).toEqual({
        applied: { applied: 'Run 1 test', ok: false, message: 'no credits left' },
      });
    });
  });

  it('says nothing was saved, why, and where the agent follows up', async () => {
    const { fetchImpl } = backend({
      'GET /projects/p1/conversations/c1': () =>
        conversation({ state: 'proposed', proposal: PLAN }),
      'POST /projects/p1/conversations/c1/apply': () => ({
        applied: '1 changed',
        ok: false,
        saved: [],
        failed: [{ path: '/test-cases/CHK-002.md', error: 'description changed in TestSprite' }],
        tests: [],
      }),
    });
    await expect(
      run(['apply', '--project', 'p1', '--conversation', 'c1'], fetchImpl),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('testsprite status --wait'),
    });
    expect(stderr.join('\n')).toContain('✗ /test-cases/CHK-002.md: description changed');
  });

  it('refuses a card nobody here has seen, even when one waits', async () => {
    const shown = backend({
      'GET /projects/p1/conversations/c1': () =>
        conversation({ state: 'proposed', proposal: PLAN }),
    });
    await run(['status', '--project', 'p1', '--conversation', 'c1'], shown.fetchImpl);
    const { calls, fetchImpl } = backend({
      'GET /projects/p1/conversations/c1': () =>
        conversation({
          state: 'proposed',
          proposal: { ...PLAN, id: 'card-2', summary: 'Fix test A, step 4' },
        }),
    });
    await expect(
      run(['apply', '--exclude', '2', '--project', 'p1', '--conversation', 'c1'], fetchImpl),
    ).rejects.toMatchObject({
      exitCode: 6,
      message: expect.stringContaining('Fix test A, step 4'),
    });
    expect(calls.some(c => c.path.endsWith('/apply'))).toBe(false);
  });

  it('asks the server about a card shown here that was decided elsewhere, and says how', async () => {
    const shown = backend({
      'GET /projects/p1/conversations/c1': () =>
        conversation({ state: 'proposed', proposal: PLAN }),
    });
    await run(['status', '--project', 'p1', '--conversation', 'c1'], shown.fetchImpl);
    const sent: string[] = [];
    const fetchImpl: FetchImpl = async (url, init = {}) => {
      const { pathname } = new URL(url instanceof Request ? url.url : String(url));
      sent.push(`${init.method ?? 'GET'} ${pathname.replace(/^\/api\/cli\/v1/, '')}`);
      if ((init.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify(conversation({ state: 'replied' })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          error: {
            code: 'CONFLICT',
            message:
              'That card was already applied at 2026-11-08T10:06:00.000Z, so nothing was decided now.',
            nextAction: '',
            requestId: 'req_1',
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    };
    await expect(
      run(['apply', '--exclude', '2', '--project', 'p1', '--conversation', 'c1'], fetchImpl),
    ).rejects.toMatchObject({ exitCode: 6, message: expect.stringContaining('already applied') });
    expect(sent).toContain('POST /projects/p1/conversations/c1/apply');
  });

  it('refuses when nothing waits to be applied', async () => {
    const { calls, fetchImpl } = backend({
      'GET /projects/p1/conversations/c1': () => conversation({ state: 'working', reply: null }),
    });
    await expect(
      run(['apply', '--project', 'p1', '--conversation', 'c1'], fetchImpl),
    ).rejects.toMatchObject({ exitCode: 6 });
    expect(calls.some(c => c.path.endsWith('/apply'))).toBe(false);
  });

  const SECRET: Conversation['proposal'] = {
    id: 'card-1',
    kind: 'secret',
    summary: 'the password for qa on staging.example.com',
    secret: { environment: 'staging', field: 'password' },
  };
  const secretCard = (applied: unknown = { applied: SECRET!.summary, ok: true }) =>
    backend({
      'GET /projects/p1/conversations/c1': () =>
        conversation({ state: 'proposed', proposal: SECRET }),
      'POST /projects/p1/conversations/c1/apply': () => applied,
    });

  const QUESTIONS: Conversation['proposal'] = {
    id: 'card-1',
    kind: 'question',
    summary: '2 questions',
    questions: [
      {
        question: 'What next?',
        header: 'Next',
        options: [
          { label: 'Round 5', description: '' },
          { label: 'Write routes', description: '' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which are bugs?',
        header: 'Bugs',
        options: [
          { label: 'The 204', description: '' },
          { label: 'The 400', description: '' },
        ],
        multiSelect: true,
      },
    ],
  };
  const questionCard = () =>
    backend({
      'GET /projects/p1/conversations/c1': () =>
        conversation({ state: 'proposed', proposal: QUESTIONS }),
      'POST /projects/p1/conversations/c1/apply': () => ({ applied: '2 questions', ok: true }),
    });

  it("answers a question card with the options' labels, by the questions' text", async () => {
    const { calls, fetchImpl } = questionCard();
    await run(
      ['apply', '--project', 'p1', '--conversation', 'c1', '--answer', '1=b', '--answer', '2=a,b'],
      fetchImpl,
    );
    expect(calls.find(c => c.path.endsWith('/apply'))!.body).toEqual({
      card: 'card-1',
      answers: { 'What next?': 'Write routes', 'Which are bugs?': 'The 204, The 400' },
    });
  });

  it('never decides a question card short of an answer, so the card keeps waiting', async () => {
    const { calls, fetchImpl } = questionCard();
    await expect(
      run(['apply', '--project', 'p1', '--conversation', 'c1', '--answer', '1=b'], fetchImpl),
    ).rejects.toMatchObject({
      exitCode: 5,
      message: expect.stringMatching(/Answer question 2 too/),
    });
    expect(calls.some(c => c.path.endsWith('/apply'))).toBe(false);
  });

  it('asks the server about a question card shown here that was answered elsewhere', async () => {
    const shown = questionCard();
    await run(['status', '--project', 'p1', '--conversation', 'c1'], shown.fetchImpl);
    const sent: string[] = [];
    const fetchImpl: FetchImpl = async (url, init = {}) => {
      const { pathname } = new URL(url instanceof Request ? url.url : String(url));
      sent.push(`${init.method ?? 'GET'} ${pathname.replace(/^\/api\/cli\/v1/, '')}`);
      if ((init.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify(conversation({ state: 'replied' })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          error: {
            code: 'CONFLICT',
            message:
              'That card was already applied at 2026-11-18T02:16:00.000Z, so nothing was decided now.',
            nextAction: '',
            requestId: 'req_1',
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    };
    await expect(
      run(['apply', '--project', 'p1', '--conversation', 'c1', '--answer', '1=b'], fetchImpl),
    ).rejects.toMatchObject({ exitCode: 6, message: expect.stringContaining('already applied') });
    expect(sent).toContain('POST /projects/p1/conversations/c1/apply');
  });

  it('sends the environment named for a run card, and says where the run started', async () => {
    const { calls, fetchImpl } = backend({
      'GET /projects/p1/conversations/c1': () =>
        conversation({
          state: 'proposed',
          proposal: {
            id: 'card-1',
            kind: 'run',
            summary: 'Run 1 test',
            run: { tests: ['k1'], environment: { id: 'e1', name: 'default', isDefault: true } },
          },
        }),
      'POST /projects/p1/conversations/c1/apply': () => ({
        applied: 'Run 1 test',
        ok: true,
        run: { runId: 'e1', tests: ['k1'], environment: 'staging' },
      }),
    });
    await run(
      ['apply', '--project', 'p1', '--conversation', 'c1', '--env', 'staging', '--no-wait'],
      fetchImpl,
    );
    expect(calls.find(c => c.path.endsWith('/apply'))!.body).toEqual({
      card: 'card-1',
      environment: 'staging',
    });
    expect(stderr).toContain('Applied: Run 1 test\n  Run started: 1 test on staging (run e1).');
  });

  it('refuses --env on a card that starts no run, and an empty --env, before anything is sent', async () => {
    const { calls, fetchImpl } = secretCard();
    await expect(
      run(['apply', '--project', 'p1', '--conversation', 'c1', '--env', 'staging'], fetchImpl),
    ).rejects.toMatchObject({ exitCode: 5, message: expect.stringMatching(/starts no run/) });
    await expect(
      run(['apply', '--project', 'p1', '--conversation', 'c1', '--env', ' '], fetchImpl),
    ).rejects.toMatchObject({ exitCode: 5, message: expect.stringMatching(/needs the name/) });
    expect(calls.some(c => c.path.endsWith('/apply'))).toBe(false);
  });

  it('refuses --answer on a card that asks no questions', async () => {
    const { calls, fetchImpl } = secretCard();
    await expect(
      run(['apply', '--project', 'p1', '--conversation', 'c1', '--answer', '1=a'], fetchImpl),
    ).rejects.toMatchObject({ exitCode: 5, message: expect.stringMatching(/asks no questions/) });
    expect(calls.some(c => c.path.endsWith('/apply'))).toBe(false);
  });

  it('never decides a secret card without its secret, so the card keeps waiting', async () => {
    const { calls, fetchImpl } = secretCard();
    await expect(
      run(['apply', '--project', 'p1', '--conversation', 'c1'], fetchImpl),
    ).rejects.toThrow(/typed by a person.*--secret-stdin/);
    expect(calls.some(c => c.path.endsWith('/apply'))).toBe(false);
  });

  it('asks a person for the secret and sends it in the body only', async () => {
    deps.interactive = true;
    deps.promptSecret = vi.fn(async () => 's3cret');
    const { calls, fetchImpl } = secretCard();
    await run(['apply', '--project', 'p1', '--conversation', 'c1'], fetchImpl);
    expect(deps.promptSecret).toHaveBeenCalledWith(
      'Type the password for qa on staging.example.com: ',
    );
    expect(calls.find(c => c.path.endsWith('/apply'))!.body).toEqual({
      card: 'card-1',
      secrets: { value: 's3cret' },
    });
  });

  it.each([
    ['The password of staging', 'Type the password of staging: '],
    ['API token for staging', 'Type API token for staging: '],
  ])('asks for "%s" mid-sentence', async (summary, question) => {
    deps.interactive = true;
    deps.promptSecret = vi.fn(async () => 's3cret');
    const { fetchImpl } = backend({
      'GET /projects/p1/conversations/c1': () =>
        conversation({ state: 'proposed', proposal: { ...SECRET!, summary } }),
      'POST /projects/p1/conversations/c1/apply': () => ({ applied: summary, ok: true }),
    });
    await run(['apply', '--project', 'p1', '--conversation', 'c1'], fetchImpl);
    expect(deps.promptSecret).toHaveBeenCalledWith(question);
  });

  it('reads the secret from what is piped in, with --secret-stdin', async () => {
    deps.readStdin = vi.fn(async () => 's3cret');
    const { calls, fetchImpl } = secretCard();
    await run(['apply', '--project', 'p1', '--conversation', 'c1', '--secret-stdin'], fetchImpl);
    expect(calls.find(c => c.path.endsWith('/apply'))!.body).toMatchObject({
      secrets: { value: 's3cret' },
    });
  });

  it('applies nothing when what was typed is empty', async () => {
    deps.interactive = true;
    deps.promptSecret = vi.fn(async () => '   ');
    const { calls, fetchImpl } = secretCard();
    await expect(
      run(['apply', '--project', 'p1', '--conversation', 'c1'], fetchImpl),
    ).rejects.toThrow(/the card still waits/);
    expect(calls.some(c => c.path.endsWith('/apply'))).toBe(false);
  });

  it('refuses --secret-stdin on a card that asks for no secret', async () => {
    const { calls, fetchImpl } = backend({
      'GET /projects/p1/conversations/c1': () =>
        conversation({ state: 'proposed', proposal: PLAN }),
    });
    await expect(
      run(['apply', '--project', 'p1', '--conversation', 'c1', '--secret-stdin'], fetchImpl),
    ).rejects.toThrow(/does not/);
    expect(calls.some(c => c.path.endsWith('/apply'))).toBe(false);
  });
});

describe('testsprite stop', () => {
  it.each([
    [{ ok: true, stopped: true }, 'Stopped.'],
    [{ ok: true }, 'Stopped.'],
    [{ ok: true, stopped: false }, 'Nothing to stop: the agent was not working.'],
  ])('says what stopping %j did', async (answer, said) => {
    const { fetchImpl } = backend({ 'POST /projects/p1/conversations/c1/stop': () => answer });
    await run(['stop', '--project', 'p1', '--conversation', 'c1'], fetchImpl);
    expect(stdout.join('\n')).toContain(said);
  });
});

describe('testsprite reply', () => {
  it('points at reject while a proposal waits', async () => {
    const { calls, fetchImpl } = backend({
      'GET /projects/p1/conversations/c1': () =>
        conversation({ state: 'proposed', proposal: PLAN }),
    });
    await expect(
      run(['reply', 'more', 'tests', '--project', 'p1', '--conversation', 'c1'], fetchImpl),
    ).rejects.toThrow(/testsprite reject/);
    expect(calls.some(c => c.path.endsWith('/messages'))).toBe(false);
  });

  it('follows on from where the conversation stood', async () => {
    const reads: string[] = [];
    const { fetchImpl } = backend({
      'GET /projects/p1/conversations/c1': () => conversation(),
      'POST /projects/p1/conversations/c1/messages': () => ({ seq: 8 }),
    });
    const spy: ConversationDeps['fetchImpl'] = async (url, init) => {
      reads.push(String(url));
      return fetchImpl(url, init);
    };
    await run(['reply', 'use', 'staging', '--project', 'p1', '--conversation', 'c1'], spy);
    expect(reads.some(u => u.includes('afterSeq=7'))).toBe(true);
  });
});

describe('testsprite status', () => {
  it('reads where the conversation stands without following it', async () => {
    const { calls, fetchImpl } = backend({
      'GET /projects/p1/conversations/c1': () => conversation({ reply: 'Two bugs found.' }),
    });
    await run(['status', '--project', 'p1', '--conversation', 'c1'], fetchImpl);
    expect(calls).toHaveLength(1);
    expect(stdout.join('\n')).toContain('Two bugs found.');
  });

  it('exits 1 for a conversation someone stopped, after saying so', async () => {
    const { fetchImpl } = backend({
      'GET /projects/p1/conversations/c1': () =>
        conversation({ state: 'stopped', stopReason: 'stopped_by_user', reply: null }),
    });
    await expect(
      run(['status', '--project', 'p1', '--conversation', 'c1'], fetchImpl),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(stdout.join('\n')).toContain('it was asked to stop');
  });
});

describe('testsprite discard', () => {
  it("drops the folder's conversation and says what it put back", async () => {
    const { calls, fetchImpl } = backend({
      'POST /projects/p1/conversations/c1/discard': () => ({
        discarded: 'c1',
        released: ['/test-cases/CHK-002.md'],
      }),
    });
    await run(['discard', '--project', 'p1', '--conversation', 'c1'], fetchImpl);
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'POST /projects/p1/conversations/c1/discard',
    ]);
    expect(stdout.join('\n')).toContain('Put back 1 unsaved file: /test-cases/CHK-002.md');
  });
});
