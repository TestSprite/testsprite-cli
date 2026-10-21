/**
 * `--output csv` / `--output ndjson` on the list commands (issue #164):
 * `project list`, `test list` and `test result --history` write rows only to
 * stdout and their pagination hints to stderr, and every other command
 * rejects both formats (exit 5) before sending a request.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import type { ListRunsResponse, RunHistoryItem } from '../lib/runs.types.js';
import { createProjectCommand, runList as runProjectList, type CliProject } from './project.js';
import {
  createTestCommand,
  runList as runTestList,
  runResultHistory,
  type CliTest,
} from './test.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function makeFetch(handler: (url: string) => unknown) {
  return vi.fn(async (input: FetchInput) => {
    const url = typeof input === 'string' ? input : input.toString();
    return new Response(JSON.stringify(handler(url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-list-output-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture: `credentialsPath` sits under this function's own mkdtempSync() directory.
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = http://localhost:13509\napi_key = sk-user-test\n',
    { mode: 0o600 },
  );
  return { credentialsPath };
}

/** Deps that capture the three output channels. */
function capture() {
  const raw: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    raw,
    stdout,
    stderr,
    sinks: {
      rawStdout: (text: string) => void raw.push(text),
      stdout: (line: string) => void stdout.push(line),
      stderr: (line: string) => void stderr.push(line),
    },
  };
}

const PROJECT: CliProject = {
  id: 'project_1',
  name: '=HYPERLINK("http://evil.example","open")',
  type: 'frontend',
  createdFrom: 'portal',
  createdAt: '2026-04-15T10:23:00.000Z',
  updatedAt: '2026-05-05T08:12:00.000Z',
  testIdAttributes: ['data-testid', 'data-qa'],
};

const TEST: CliTest = {
  id: 'test_1',
  projectId: 'project_1',
  name: 'Checkout, "happy" path',
  type: 'frontend',
  createdFrom: 'cli',
  status: 'failed',
  headlineEnvironment: { id: 'env_1', name: 'staging' },
  createdAt: '2026-04-20T11:00:00.000Z',
  updatedAt: '2026-05-05T12:34:56.000Z',
  planSteps: [],
  produces: ['cartId'],
};

const RUN: RunHistoryItem = {
  runId: 'run_1',
  status: 'failed',
  source: 'cli',
  isRerun: true,
  createdFrom: 'rerun:run_0',
  createdAt: '2026-06-03T10:00:00.000Z',
  startedAt: '2026-06-03T10:00:05.000Z',
  finishedAt: '2026-06-03T10:02:00.000Z',
  codeVersion: 'v1',
  failureKind: 'assertion',
  environment: { id: 'env_1', name: 'staging' } as RunHistoryItem['environment'],
};

describe('project list --output csv | ndjson', () => {
  it('csv: header from CliProject fields, guarded and quoted cells, CRLF records', async () => {
    const io = capture();
    await runProjectList(
      { profile: 'default', output: 'json', format: 'csv', debug: false },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(() => ({ items: [PROJECT], nextToken: null })),
        ...io.sinks,
      },
    );
    expect(io.raw).toEqual([
      'id,name,type,createdFrom,createdAt,updatedAt,orgId,orgName,targetUrl,defaultEnvironment,environmentCount,originMode,testIdAttributes\r\n' +
        `project_1,"'=HYPERLINK(""http://evil.example"",""open"")",frontend,portal,2026-04-15T10:23:00.000Z,2026-05-05T08:12:00.000Z,,,,,,,"data-testid,data-qa"\r\n`,
    ]);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([]);
  });

  it('ndjson: the wire object per line, unescaped; the cursor goes to stderr', async () => {
    const io = capture();
    await runProjectList(
      { profile: 'default', output: 'json', format: 'ndjson', debug: false, pageSize: 1 },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(() => ({ items: [PROJECT], nextToken: 'cursor_2' })),
        ...io.sinks,
      },
    );
    expect(io.raw).toEqual([`${JSON.stringify(PROJECT)}\n`]);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual(['nextToken: cursor_2']);
  });

  it('accumulates auto-paged pages into one table', async () => {
    const io = capture();
    const second = { ...PROJECT, id: 'project_2', name: 'Second' };
    await runProjectList(
      { profile: 'default', output: 'json', format: 'csv', debug: false },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(url =>
          url.includes('cursor=p2')
            ? { items: [second], nextToken: null }
            : { items: [PROJECT], nextToken: 'p2' },
        ),
        ...io.sinks,
      },
    );
    const records = io.raw.join('').split('\r\n');
    expect(records.map(record => record.split(',')[0])).toEqual([
      'id',
      'project_1',
      'project_2',
      '',
    ]);
  });

  it('an empty list is a header-only csv and no ndjson output', async () => {
    for (const format of ['csv', 'ndjson'] as const) {
      const io = capture();
      await runProjectList(
        { profile: 'default', output: 'json', format, debug: false },
        {
          ...makeCreds(),
          fetchImpl: makeFetch(() => ({ items: [], nextToken: null })),
          ...io.sinks,
        },
      );
      if (format === 'csv')
        expect(io.raw.join('')).toMatch(/^id,name,[^\r\n]*,testIdAttributes\r\n$/);
      else expect(io.raw).toEqual([]);
      expect(io.stdout).toEqual([]);
    }
  });
});

describe('test list --output csv | ndjson', () => {
  it('csv: flattens the headline environment and leaves nested fields out', async () => {
    const io = capture();
    await runTestList(
      { profile: 'default', output: 'json', format: 'csv', debug: false, projectId: 'project_1' },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(() => ({ items: [TEST], nextToken: null })),
        ...io.sinks,
      },
    );
    const [header, row] = io.raw.join('').split('\r\n');
    expect(header).toBe(
      'id,projectId,projectName,name,type,isIntegration,createdFrom,status,headlineEnvironment,createdAt,updatedAt,planStepCount,priority,stepTimeoutMs,produces,consumes,category',
    );
    expect(header).not.toContain('planSteps');
    expect(row).toBe(
      'test_1,project_1,,"Checkout, ""happy"" path",frontend,,cli,failed,staging,2026-04-20T11:00:00.000Z,2026-05-05T12:34:56.000Z,,,,cartId,,',
    );
  });

  it('ndjson: keeps nested fields and routes the cursor to stderr', async () => {
    const io = capture();
    await runTestList(
      {
        profile: 'default',
        output: 'json',
        format: 'ndjson',
        debug: false,
        projectId: 'project_1',
        pageSize: 1,
      },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(() => ({ items: [TEST], nextToken: 'cursor_2' })),
        ...io.sinks,
      },
    );
    expect(JSON.parse(io.raw.join(''))).toEqual(TEST);
    expect(io.stderr).toEqual(['nextToken: cursor_2']);
  });
});

describe('test result --history --output csv | ndjson', () => {
  function historyFetch(resp: ListRunsResponse) {
    return makeFetch(() => resp);
  }

  it('csv: one row per run with the environment name; next cursor on stderr', async () => {
    const io = capture();
    await runResultHistory(
      { profile: 'default', output: 'json', format: 'csv', debug: false, testId: 'test_1' },
      {
        ...makeCreds(),
        fetchImpl: historyFetch({ runs: [RUN], nextCursor: 'c2', meta: { testKind: 'frontend' } }),
        ...io.sinks,
      },
    );
    expect(io.raw).toEqual([
      'runId,status,source,isRerun,createdFrom,createdAt,startedAt,finishedAt,codeVersion,failureKind,targetUrl,targetUrlSource,environment\r\n' +
        'run_1,failed,cli,true,rerun:run_0,2026-06-03T10:00:00.000Z,2026-06-03T10:00:05.000Z,2026-06-03T10:02:00.000Z,v1,assertion,,,staging\r\n',
    ]);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual(['Next page: --cursor c2']);
  });

  it('ndjson: applies the client-side rerun filter; the empty-history note goes to stderr', async () => {
    const io = capture();
    await runResultHistory(
      {
        profile: 'default',
        output: 'json',
        format: 'ndjson',
        debug: false,
        testId: 'test_1',
        rerun: false,
      },
      {
        ...makeCreds(),
        fetchImpl: historyFetch({
          runs: [RUN],
          nextCursor: null,
          meta: { testKind: 'frontend', note: 'No runs yet.' },
        }),
        ...io.sinks,
      },
    );
    expect(io.raw).toEqual([]);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual(['No runs yet.']);
  });
});

describe('--output csv | ndjson on other commands', () => {
  function program(sub: Command): Command {
    const root = new Command().option('--output <mode>').exitOverride();
    root.addCommand(sub);
    return root;
  }

  it.each([
    ['csv', ['project', 'get', 'project_1']],
    [
      'ndjson',
      ['project', 'create', '--type', 'frontend', '--name', 'x', '--url', 'https://a.example'],
    ],
  ])('%s: `%s` exits 5 before any request', async (format, argv) => {
    const fetchImpl = makeFetch(() => ({}));
    const io = capture();
    await expect(
      program(createProjectCommand({ ...makeCreds(), fetchImpl, ...io.sinks })).parseAsync(
        ['--output', format, ...argv],
        { from: 'user' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['csv', ['test', 'run', 'test_1']],
    ['ndjson', ['test', 'result', 'test_1']],
  ])('%s: `%s` exits 5 before any request', async (format, argv) => {
    const fetchImpl = makeFetch(() => ({}));
    const io = capture();
    await expect(
      program(createTestCommand({ ...makeCreds(), fetchImpl, ...io.sinks })).parseAsync(
        ['--output', format, ...argv],
        { from: 'user' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('the list actions accept them', async () => {
    const io = capture();
    const fetchImpl = makeFetch(url =>
      url.includes('/runs')
        ? { runs: [RUN], nextCursor: null, meta: {} }
        : { items: [], nextToken: null },
    );
    const deps = { ...makeCreds(), fetchImpl, ...io.sinks };
    await program(createProjectCommand(deps)).parseAsync(['--output', 'csv', 'project', 'list'], {
      from: 'user',
    });
    await program(createTestCommand(deps)).parseAsync(
      ['--output', 'ndjson', 'test', 'list', '--project', 'project_1'],
      { from: 'user' },
    );
    await program(createTestCommand(deps)).parseAsync(
      ['--output', 'ndjson', 'test', 'result', 'test_1', '--history'],
      { from: 'user' },
    );
    expect(io.raw).toEqual([expect.stringMatching(/^id,name,/), `${JSON.stringify(RUN)}\n`]);
  });
});
