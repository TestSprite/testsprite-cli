import { describe, expect, it } from 'vitest';
import type { HttpClient } from '../lib/http.js';
import { buildTestNameMap, resolveRunCardIsBackend } from './test.js';

function failingClient(message: string): HttpClient {
  return {
    get: async () => {
      throw new Error(message);
    },
  } as unknown as HttpClient;
}

describe('resolveRunCardIsBackend — debug diagnostics', () => {
  it('reports a failed type lookup on stderr only in debug mode without altering the fallback', async () => {
    const debugStderr: string[] = [];
    const normalStderr: string[] = [];
    const client = failingClient('lookup boom');

    const withDebug = await resolveRunCardIsBackend(
      client,
      'test_x',
      'text',
      false,
      'failed',
      undefined,
      line => debugStderr.push(line),
      true,
    );
    const withoutDebug = await resolveRunCardIsBackend(
      client,
      'test_x',
      'text',
      false,
      'failed',
      undefined,
      line => normalStderr.push(line),
      false,
    );

    expect(withDebug).toBe(false);
    expect(withoutDebug).toBe(false);
    expect(withDebug).toBe(withoutDebug);
    expect(
      debugStderr.some(line => line.includes('[debug] run card backend type lookup failed:')),
    ).toBe(true);
    expect(normalStderr).toEqual([]);
  });
});

describe('buildTestNameMap — debug diagnostics', () => {
  it('reports a failed name lookup on stderr only in debug mode without altering the map', async () => {
    const debugStderr: string[] = [];
    const normalStderr: string[] = [];
    const client = failingClient('name boom');

    const withDebug = await buildTestNameMap(
      client,
      'project_x',
      line => debugStderr.push(line),
      true,
    );
    const withoutDebug = await buildTestNameMap(
      client,
      'project_x',
      line => normalStderr.push(line),
      false,
    );

    expect([...withDebug]).toEqual([]);
    expect([...withoutDebug]).toEqual([]);
    expect([...withDebug]).toEqual([...withoutDebug]);
    expect(debugStderr.some(line => line.includes('[debug] junit test name lookup failed:'))).toBe(
      true,
    );
    expect(normalStderr).toEqual([]);
  });
});
