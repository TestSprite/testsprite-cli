import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeProfile } from '../lib/credentials.js';
import { RequestTimeoutError } from '../lib/errors.js';
import type { FetchImpl } from '../lib/http.js';
import { createConversationCommands } from './conversation.js';

const UPLOAD_URL = 'https://storage.example.com/uploads/notes.md?signature=abc';
const PENDING = Symbol('pending');

/**
 * A backend that starts a conversation and mints an upload URL, in front of
 * storage that takes the PUT and never answers until the request is aborted.
 */
function backendWithSilentStorage() {
  let reach!: () => void;
  const reached = new Promise<void>(resolve => {
    reach = resolve;
  });
  const fetchImpl: FetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (init.method === 'PUT') {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        reach();
      });
    }
    const answer = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    // The reads before the conversation starts are best effort; let them miss.
    if (init.method !== 'POST') return answer({}, 404);
    return url.endsWith('/files')
      ? answer({ uploadUrl: UPLOAD_URL, name: 'notes.md' })
      : answer({ id: 'c1', url: 'https://portal/c1', model: 'm' });
  };
  return { fetchImpl, reached };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('testsprite plan --file against storage that never answers', () => {
  it.each([
    [
      '--request-timeout, over the environment variable',
      ['--request-timeout', '2'],
      { TESTSPRITE_REQUEST_TIMEOUT_MS: '5000' },
      2_000,
    ],
    [
      'TESTSPRITE_REQUEST_TIMEOUT_MS, without the flag',
      [],
      { TESTSPRITE_REQUEST_TIMEOUT_MS: '5000' },
      5_000,
    ],
    ['the 120 s default, with neither', [], {}, 120_000],
  ] as const)('gives up after %s', async (_name, globals, env, deadlineMs) => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-conversation-upload-'));
    const credentialsPath = join(dir, 'credentials');
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const notes = join(dir, 'notes.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixture under this test's own temp directory.
    writeFileSync(notes, '# notes');
    const { fetchImpl, reached } = backendWithSilentStorage();

    const program = new Command()
      .exitOverride()
      .option('--output <mode>', '', 'text')
      .option('--profile <name>')
      .option('--endpoint-url <url>')
      .option('--dry-run')
      .option('--debug')
      .option('--verbose')
      .option('--request-timeout <seconds>');
    const commands = createConversationCommands({
      env,
      credentialsPath,
      cwd: dir,
      git: () => ({ ok: false, stdout: '' }),
      interactive: false,
      fetchImpl,
      stdout: () => {},
      stderr: () => {},
      sleep: async () => {},
    });
    for (const command of commands) program.addCommand(command.exitOverride());

    // Only the timers the deadline runs on: the rest of the command stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let outcome: unknown = PENDING;
    program
      .parseAsync([
        'node',
        'testsprite',
        ...globals,
        'plan',
        'x',
        '--project',
        'p1',
        '--file',
        notes,
      ])
      .then(
        () => {
          outcome = 'finished';
        },
        (err: unknown) => {
          outcome = err;
        },
      );
    await reached;
    await vi.advanceTimersByTimeAsync(deadlineMs - 1);
    expect(outcome).toBe(PENDING);
    await vi.advanceTimersByTimeAsync(1);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(outcome).toBeInstanceOf(RequestTimeoutError);
    expect(outcome).toMatchObject({ exitCode: 7, timeoutMs: deadlineMs });
  });
});
