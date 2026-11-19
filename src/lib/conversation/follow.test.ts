import { describe, expect, it, vi } from 'vitest';
import type { ConversationApi } from './api.js';
import { followConversation } from './follow.js';
import type { Conversation, ConversationEvent } from './types.js';

function conversation(over: Partial<Conversation>): Conversation {
  return {
    id: 'c1',
    projectId: 'p1',
    title: null,
    url: 'https://portal/c1',
    state: 'working',
    model: 'claude-opus-5-5',
    lastSeq: 0,
    events: [],
    proposal: null,
    reply: null,
    ...over,
  };
}

const activity = (seq: number, text: string): ConversationEvent => ({
  seq,
  at: '2026-01-01T00:00:00.000Z',
  kind: 'activity',
  text,
});

function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function api(answers: Array<(afterSeq: number) => Conversation>, onGet?: () => void) {
  const get = vi.fn(async (_p: string, _id: string, follow?: { afterSeq: number }) => {
    onGet?.();
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next(follow?.afterSeq ?? -1);
  });
  return { api: { get } as unknown as ConversationApi, get };
}

describe('followConversation', () => {
  it('prints progress as it comes and stops when the agent needs someone', async () => {
    const c = clock();
    const { api: fake, get } = api(
      [
        () => conversation({ events: [activity(1, 'Opening a browser')], lastSeq: 1 }),
        after => {
          expect(after).toBe(1);
          return conversation({
            state: 'proposed',
            events: [activity(2, 'Saving test cases to TestSprite')],
            lastSeq: 2,
          });
        },
      ],
      () => c.advance(2_000),
    );
    const seen: string[] = [];
    const result = await followConversation(fake, 'p1', 'c1', {
      afterSeq: 0,
      timeoutMs: null,
      onEvent: e => seen.push(e.kind === 'activity' ? e.text : ''),
      now: c.now,
      sleep: c.sleep,
    });
    expect(seen).toEqual(['Opening a browser', 'Saving test cases to TestSprite']);
    expect(result).toMatchObject({ timedOut: false, conversation: { state: 'proposed' } });
    expect(result.events).toHaveLength(2);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('asks the server to hold each request, never past the deadline', async () => {
    const c = clock();
    const { api: fake, get } = api([() => conversation({}), () => conversation({})], () =>
      c.advance(25_000),
    );
    const result = await followConversation(fake, 'p1', 'c1', {
      afterSeq: 5,
      timeoutMs: 30_000,
      onEvent: () => {},
      now: c.now,
      sleep: c.sleep,
    });
    expect(get.mock.calls[0]?.[2]).toMatchObject({ afterSeq: 5, waitSeconds: 25 });
    expect(get.mock.calls[1]?.[2]).toMatchObject({ waitSeconds: 5 });
    expect(result.timedOut).toBe(true);
  });

  it('pauses between requests the server answers at once with nothing new', async () => {
    const c = clock();
    const { api: fake } = api([
      () => conversation({}),
      () => conversation({ state: 'replied', reply: 'Done.' }),
    ]);
    await followConversation(fake, 'p1', 'c1', {
      afterSeq: 0,
      timeoutMs: null,
      onEvent: () => {},
      now: c.now,
      sleep: c.sleep,
    });
    expect(c.sleep).toHaveBeenCalledWith(1_000);
  });
});
