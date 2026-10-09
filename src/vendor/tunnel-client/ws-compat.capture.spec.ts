import diagnosticsChannel from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_GRACE_MS, WsCompatSocket, upgradeRequestMatchesTarget } from './ws-compat.js';

const websocketState = vi.hoisted(() => ({
  instances: [] as EventTarget[],
  constructorError: undefined as Error | undefined,
}));

// Replace only the network boundary. Capture runs against real diagnostics
// channels, and close settlement runs against the real shim with fake time.
vi.mock('undici', () => ({
  WebSocket: class extends EventTarget {
    readyState = 0;

    constructor(_url: URL | string) {
      super();
      if (websocketState.constructorError) throw websocketState.constructorError;
      websocketState.instances.push(this);
    }

    close(): void {
      this.readyState = 2;
    }
  },
}));

type UpgradeRequest = NonNullable<Parameters<typeof upgradeRequestMatchesTarget>[0]> & {
  origin?: unknown;
};

describe('upgradeRequestMatchesTarget', () => {
  it.each<[string, string, UpgradeRequest | undefined, boolean]>([
    [
      'plain HTTP upgrade with an implicit default port',
      'ws://control.example/control?session=one',
      { origin: 'http://control.example', path: '/control?session=one', upgrade: 'websocket' },
      true,
    ],
    [
      'secure HTTP upgrade with an explicit default port',
      'wss://control.example/control',
      { origin: 'https://control.example:443', path: '/control', upgrade: 'WebSocket' },
      true,
    ],
    [
      'nondefault port',
      'ws://control.example:9090/control',
      { origin: 'http://control.example:9090', path: '/control', upgrade: 'websocket' },
      true,
    ],
    [
      'IPv6 origin',
      'wss://[::1]:9443/control',
      { origin: 'https://[::1]:9443', path: '/control', upgrade: 'websocket' },
      true,
    ],
    [
      'another host with the same upgrade path',
      'ws://control.example/control',
      { origin: 'http://other.example', path: '/control', upgrade: 'websocket' },
      false,
    ],
    [
      'another port with the same upgrade path',
      'ws://control.example:9090/control',
      { origin: 'http://control.example:9091', path: '/control', upgrade: 'websocket' },
      false,
    ],
    [
      'another transport scheme on the same port',
      'wss://control.example/control',
      { origin: 'http://control.example:443', path: '/control', upgrade: 'websocket' },
      false,
    ],
    [
      'another query',
      'ws://control.example/control?session=one',
      { origin: 'http://control.example', path: '/control?session=two', upgrade: 'websocket' },
      false,
    ],
    [
      'ordinary HTTP request',
      'ws://control.example/control',
      { origin: 'http://control.example', path: '/control' },
      false,
    ],
    ['absent request', 'ws://control.example/control', undefined, false],
    [
      'absent origin',
      'ws://control.example/control',
      { path: '/control', upgrade: 'websocket' },
      false,
    ],
    [
      'malformed origin',
      'ws://control.example/control',
      { origin: 'not a URL', path: '/control', upgrade: 'websocket' },
      false,
    ],
    [
      'nonstring origin',
      'ws://control.example/control',
      { origin: {}, path: '/control', upgrade: 'websocket' },
      false,
    ],
    [
      'proxy absolute-form upgrade path',
      'ws://control.example/control?session=one',
      {
        origin: 'http://proxy.example:8080',
        path: 'http://control.example:80/control?session=one',
        upgrade: 'websocket',
      },
      true,
    ],
    [
      'proxy absolute-form path to another host',
      'ws://control.example/control',
      {
        origin: 'http://proxy.example:8080',
        path: 'http://other.example/control',
        upgrade: 'websocket',
      },
      false,
    ],
    [
      'proxy absolute-form path to another port',
      'ws://control.example:9090/control',
      {
        origin: 'http://proxy.example:8080',
        path: 'http://control.example:9091/control',
        upgrade: 'websocket',
      },
      false,
    ],
  ])('matches only this connection: %s', (_name, target, request, expected) => {
    expect(upgradeRequestMatchesTarget(request, new URL(target))).toBe(expected);
  });
});

class SocketReference {
  unrefs = 0;

  unref(): void {
    this.unrefs += 1;
  }
}

const connectedChannel = diagnosticsChannel.channel('undici:client:connected');
const sendHeadersChannel = diagnosticsChannel.channel('undici:client:sendHeaders');
const realChannel = diagnosticsChannel.channel;
type Subscriber = Parameters<typeof connectedChannel.subscribe>[0];

describe('WebSocket diagnostics capture lifecycle', () => {
  const subscriptions: { channel: typeof connectedChannel; subscriber: Subscriber }[] = [];
  let failHeadersSubscription = false;

  beforeEach(() => {
    vi.useFakeTimers();
    websocketState.instances.length = 0;
    websocketState.constructorError = undefined;
    subscriptions.length = 0;
    failHeadersSubscription = false;
    // Channel.subscribe switches prototypes and calls itself again; a spy on
    // that method changes its semantics. Wrap lookup instead and keep the
    // actual subscriptions/publications intact.
    vi.spyOn(diagnosticsChannel, 'channel').mockImplementation(name => {
      const channel = realChannel(name);
      return {
        subscribe(subscriber: Subscriber): void {
          if (failHeadersSubscription && channel === sendHeadersChannel) {
            throw new Error('diagnostics unavailable');
          }
          subscriptions.push({ channel, subscriber });
          channel.subscribe(subscriber);
        },
        unsubscribe(subscriber: Subscriber): void {
          channel.unsubscribe(subscriber);
        },
      } as unknown as typeof channel;
    });
  });

  afterEach(() => {
    // Keep a failed leak assertion from contaminating the next case.
    for (const { channel, subscriber } of subscriptions) {
      channel.unsubscribe(subscriber);
    }
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('releases the reused upgrade socket while ignoring another origin on the same path', () => {
    const facade = new WsCompatSocket('ws://control.example/control');
    const ownSocket = new SocketReference();
    const otherSocket = new SocketReference();
    const closes: number[] = [];
    facade.on('close', code => closes.push(code));

    // No connected event: a pooled keep-alive socket carries this upgrade.
    sendHeadersChannel.publish({
      request: { origin: 'http://other.example', path: '/control', upgrade: 'websocket' },
      headers: '',
      socket: otherSocket,
    });
    sendHeadersChannel.publish({
      request: { origin: 'http://control.example', path: '/control', upgrade: 'websocket' },
      headers: '',
      socket: ownSocket,
    });
    sendHeadersChannel.publish({
      request: { origin: 'http://other.example', path: '/control', upgrade: 'websocket' },
      headers: '',
      socket: otherSocket,
    });
    websocketState.instances[0]!.dispatchEvent(new Event('open'));

    facade.close();
    vi.advanceTimersByTime(CLOSE_GRACE_MS);

    expect(ownSocket.unrefs).toBe(1);
    expect(otherSocket.unrefs).toBe(0);
    expect(closes).toEqual([1006]);
    expect(connectedChannel.hasSubscribers).toBe(false);
    expect(sendHeadersChannel.hasSubscribers).toBe(false);
  });

  it.each(['open', 'error', 'close'])(
    'removes both subscriptions on %s without requiring a close listener',
    event => {
      new WsCompatSocket('ws://control.example/control');
      expect(connectedChannel.hasSubscribers).toBe(true);
      expect(sendHeadersChannel.hasSubscribers).toBe(true);

      websocketState.instances[0]!.dispatchEvent(
        Object.assign(new Event(event), { code: 1000, reason: '' }),
      );

      expect(connectedChannel.hasSubscribers).toBe(false);
      expect(sendHeadersChannel.hasSubscribers).toBe(false);
    },
  );

  it('removes both subscriptions when WebSocket construction throws', () => {
    websocketState.constructorError = new TypeError('invalid WebSocket URL');

    expect(() => new WsCompatSocket('http://control.example/control')).toThrow(
      'invalid WebSocket URL',
    );

    expect(connectedChannel.hasSubscribers).toBe(false);
    expect(sendHeadersChannel.hasSubscribers).toBe(false);
  });

  it('closes the capture window immediately when local close begins', () => {
    const facade = new WsCompatSocket('ws://control.example/control');
    const otherSocket = new SocketReference();

    facade.close();
    expect(connectedChannel.hasSubscribers).toBe(false);
    expect(sendHeadersChannel.hasSubscribers).toBe(false);
    sendHeadersChannel.publish({
      request: { origin: 'http://control.example', path: '/control', upgrade: 'websocket' },
      headers: '',
      socket: otherSocket,
    });
    vi.advanceTimersByTime(CLOSE_GRACE_MS);

    expect(otherSocket.unrefs).toBe(0);
  });

  it('cleans up a partial diagnostic subscription when the companion subscription throws', () => {
    failHeadersSubscription = true;

    new WsCompatSocket('ws://control.example/control');

    expect(connectedChannel.hasSubscribers).toBe(false);
    expect(sendHeadersChannel.hasSubscribers).toBe(false);
  });
});
