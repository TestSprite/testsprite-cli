import { MAX_WAIT_SECONDS, type ConversationApi } from './api.js';
import type { Conversation, ConversationEvent } from './types.js';

/** How long to pause when the server answers at once with nothing new, so a busy agent isn't polled hot. */
const IDLE_POLL_MS = 1_000;

export interface FollowOptions {
  afterSeq: number;
  /** Stop following after this long and report the agent still working; null follows until it stops. */
  timeoutMs: number | null;
  onEvent: (event: ConversationEvent) => void;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FollowResult {
  conversation: Conversation;
  /** Every event seen while following, oldest first. */
  events: ConversationEvent[];
  /** The deadline passed while the agent was still working. */
  timedOut: boolean;
}

/**
 * Follow a conversation until the agent needs someone: it proposed something,
 * replied, stopped, or the conversation ended. Each request is held by the
 * server until something happens, so progress shows as it comes.
 */
export async function followConversation(
  api: ConversationApi,
  projectId: string,
  id: string,
  options: FollowOptions,
): Promise<FollowResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = options.timeoutMs === null ? null : now() + options.timeoutMs;
  const events: ConversationEvent[] = [];
  let afterSeq = options.afterSeq;
  for (;;) {
    const left = deadline === null ? Infinity : deadline - now();
    const waitSeconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(left / 1000)));
    const started = now();
    const conversation = await api.get(projectId, id, {
      afterSeq,
      waitSeconds,
      signal: options.signal,
    });
    for (const event of conversation.events) {
      events.push(event);
      options.onEvent(event);
    }
    afterSeq = conversation.lastSeq;
    if (conversation.state !== 'working') return { conversation, events, timedOut: false };
    if (deadline !== null && now() >= deadline) return { conversation, events, timedOut: true };
    const answeredAtOnce = now() - started < IDLE_POLL_MS;
    if (conversation.events.length === 0 && answeredAtOnce) {
      await sleep(Math.min(IDLE_POLL_MS, deadline === null ? IDLE_POLL_MS : deadline - now()));
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}
