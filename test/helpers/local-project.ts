import { projectRun, runListing } from './project-run.js';
import { resultLine } from './result-list.js';
import { createRunCommand } from '../../src/commands/test.js';
import type { ShutdownController } from '../../src/lib/interrupt.js';
export type Case = { id: string; projectId: string; type: 'frontend' | 'backend' };
export type Call = { method: string; url: URL; body?: Record<string, unknown>; key: string | null };
export const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
export function fixture(
  tests: Case[],
  config: {
    environmentUrl?: (project: string) => string;
    answer?: (call: Call, init: RequestInit) => Response | Promise<Response | undefined> | void;
    shutdown?: ShutdownController;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const calls: Call[] = [],
    stdout: string[] = [],
    stderr: string[] = [];
  const selected = new Map<string, Case[]>();
  let stops = 0;
  const envUrl = (project: string) => config.environmentUrl?.(project) ?? 'http://127.0.0.1:5173';
  const deps = {
    env: { TESTSPRITE_API_KEY: 'sk-user-fixture', TESTSPRITE_API_URL: 'https://api.example.com' },
    stdout: (line: string) => {
      stdout.push(line);
    },
    stderr: (line: string) => {
      stderr.push(line);
    },
    sleep: config.sleep ?? (async () => {}),
    shutdown: config.shutdown,
    createTunnelClient: () => ({
      start: async () => {},
      stop: async () => {
        stops++;
      },
    }),
    fetchImpl: async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const call = {
        url,
        method: init.method ?? 'GET',
        body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
        key: new Headers(init.headers).get('idempotency-key'),
      };
      calls.push(call);
      const overridden = await config.answer?.(call, init);
      if (overridden) return overridden;
      const path = url.pathname.replace('/api/cli/v1', '');
      if (call.method === 'GET' && path === '/tests')
        return json({ items: tests.map(test => ({ ...test, title: test.id })), nextToken: null });
      if (call.method === 'GET' && path.startsWith('/tests/')) {
        const test = tests.find(test => test.id === path.slice(7));
        return test
          ? json(test)
          : json(
              {
                code: 'NOT_FOUND',
                message: 'missing test',
                requestId: 'missing',
                nextAction: 'check ID',
                details: {},
              },
              404,
            );
      }
      const project = path.match(/^\/projects\/([^/]+)(?:\/(env|runs))?$/);
      if (project?.[2] === 'env')
        return json({
          environments: [
            { id: `env-${project[1]}`, name: 'default', url: envUrl(project[1]!), isDefault: true },
          ],
        });
      if (project && !project[2])
        return json({
          id: project[1],
          type: tests.find(test => test.projectId === project[1])?.type ?? 'frontend',
        });
      if (project?.[2] === 'runs' && call.method === 'POST') {
        const runId = `exec-${project[1]}`;
        const members = tests.filter(
          test =>
            test.projectId === project[1] &&
            (!call.body?.testIds || (call.body.testIds as string[]).includes(test.id)),
        );
        selected.set(runId, members);
        return json(
          projectRun({
            runId,
            projectId: project[1],
            total: members.length,
            targetUrl: (call.body?.targetUrl as string) ?? envUrl(project[1]!),
            environment: {
              id: `env-${project[1]}`,
              name: (call.body?.environment as string) ?? 'default',
            },
            tunnelClientId: call.body?.tunnelClientId as string | undefined,
            maxConcurrency: call.body?.maxConcurrency as number,
          }),
        );
      }
      if (path === '/results') {
        const runId = url.searchParams.get('run')!;
        return json(
          runListing(
            { runId, projectId: runId.slice(5), status: 'finished', cancelled: false },
            (selected.get(runId) ?? []).map(test =>
              resultLine({
                resultId: `result-${test.id}`,
                runId,
                caseKey: test.id,
                title: test.id,
                testStatus: 'PASSED',
              }),
            ),
          ),
        );
      }
      if (path.endsWith('/cancel'))
        return json({
          runId: path.split('/')[2],
          alreadyCancelled: false,
          alreadyFinished: false,
          results: [],
        });
      if (path === '/tunnel')
        return json({
          clientId: 'client-local',
          secret: 'fixture-secret',
          controlUrl: 'ws://tunnel.example:7300/ws',
          tunnelAddr: 'tunnel.example:7400',
          expiresAt: '2026-11-15T23:00:00Z',
        });
      if (path.startsWith('/tunnel/'))
        return call.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : json({ clientId: 'client-local', status: 'online', expiresAt: '2026-11-15T23:00:00Z' });
      throw new Error(`Unexpected ${call.method} ${path}`);
    },
  };
  return {
    deps,
    calls,
    stdout,
    stderr,
    stops: () => stops,
    launches: () =>
      calls.filter(
        call => call.method === 'POST' && /\/projects\/[^/]+\/runs$/.test(call.url.pathname),
      ),
    output: () => JSON.parse(stdout.join('\n')),
    run: (args: string[]) =>
      createRunCommand(deps)
        .option('--output <mode>')
        .option('--dry-run')
        .parseAsync([...args, '--skip-preflight', '--output', 'json'], { from: 'user' }),
  };
}
export const cases = (count: number, projectId = 'P'): Case[] =>
  Array.from({ length: count }, (_, i) => ({ id: `test-${i}`, projectId, type: 'frontend' }));
