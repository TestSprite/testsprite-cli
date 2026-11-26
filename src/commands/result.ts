import { Command } from 'commander';
import {
  makeHttpClient,
  resolveCommonOptions,
  resolveRequestTimeoutMs,
  type CommonOptions,
} from '../lib/client-factory.js';
import { assertOutDirParentExists, resolveOutDir } from '../lib/download.js';
import { ApiError, localValidationError } from '../lib/errors.js';
import type { FetchImpl, HttpClient } from '../lib/http.js';
import { historyRetentionNote } from '../lib/history-retention.js';
import { GLOBAL_OPTS_HINT, Output } from '../lib/output.js';
import { resultApi } from '../lib/result/api.js';
import {
  hasFailedStep,
  planEvidence,
  RESULT_FILE,
  writeEvidence,
  type WrittenEvidence,
} from '../lib/result/evidence.js';
import { renderEvidence, renderResultDetail, renderResultList } from '../lib/result/render.js';
import { ALL_RESULT_STATUSES, type ResultDetail, type ResultList } from '../lib/result/types.js';
import { terminalSafeWriter } from '../lib/terminal-text.js';

export interface ResultDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface ListFlags {
  test?: string;
  run?: string;
  status?: string[];
  env?: string;
  limit?: string;
}

interface GetFlags {
  out?: string;
  failedOnly?: boolean;
}

/** What one `result list` asks for: a run's results, or one test's. */
type ListQuery =
  | { run: string; statuses?: string[] }
  | { test: string; statuses?: string[]; env?: string; limit?: number };

const MAX_LIMIT = 100;

export function createResultCommand(deps: ResultDeps = {}): Command {
  const result = new Command('result').description('List and read test results');

  result
    .command('list')
    .summary('List the results of a run or of a test')
    .description(
      "List the results of one run (--run <run-id>), or one test's results across runs,\n" +
        'newest first (--test <test-id>). A run id is the runId testsprite run prints;\n' +
        "a result is one test's part of a run, printed as resultId.\n" +
        '\nRead one result with: testsprite result get <result-id>\n' +
        '\nExit codes:\n' +
        '  0  listed, whatever the verdicts\n' +
        '  3  auth error\n' +
        '  4  run or test not found\n' +
        '  5  validation error',
    )
    .option('--run <run-id>', 'list the results of this run')
    .option('--test <test-id>', "list this test's results, newest first")
    .option(
      '--status <list>',
      `keep only these statuses: ${ALL_RESULT_STATUSES.join(', ')} (comma-separated or ` +
        'repeated, any case). Running includes queued results. Cancelled results are listed only when named',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--env <name>', 'with --test: only results from this project environment')
    .option('--limit <n>', `with --test: how many results (1-${MAX_LIMIT}, default 20)`)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (flags: ListFlags, command: Command) => {
      await runResultList(resolveCommonOptions(command, deps.env), flags, deps);
    });

  result
    .command('get <result-id>')
    .summary('Read one result: verdict, cause, failed step')
    .description(
      "Read one result: its verdict, error, cause and fix, the failed step's screenshot and\n" +
        "the video. A result is one test's part of a run, printed as resultId. Every step is\n" +
        'in --output json.\n' +
        '\nWith --out <dir>, download it instead: result.json (the result, each link replaced\n' +
        "by the file it was written to), the video, and each step's screenshot and page as\n" +
        'steps/001.png, steps/001.html, ...; a result blocked at sign-in adds the sign-in\n' +
        "run's video and steps under sign-in/. <dir> is created if missing. In an existing\n" +
        '<dir>, result.json, video.<mp4|webm|mov|mkv|avi>, steps/ and sign-in/ are replaced\n' +
        'once the download ends, and every other file is left alone; a file that fails keeps\n' +
        'the copy an earlier download of the same result left.\n' +
        '\nExit codes:\n' +
        '   0  read, whatever the verdict (with --out: every file written)\n' +
        '   3  auth error\n' +
        '   4  result not found\n' +
        '   5  validation error\n' +
        '  10  with --out: a file could not be downloaded; the others and result.json are written',
    )
    .option(
      '--out <dir>',
      "write the result and its evidence (video, each step's files) into <dir>",
    )
    .option(
      '--failed-only',
      'with --out: only the failed steps and one step on each side (every step when none failed)',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (resultId: string, flags: GetFlags, command: Command) => {
      await runResultGet(resolveCommonOptions(command, deps.env), resultId, flags, deps);
    });

  return result;
}

async function runResultList(
  opts: CommonOptions,
  flags: ListFlags,
  deps: ResultDeps,
): Promise<ResultList> {
  const query = listQuery(flags);
  const client = makeClient(opts, deps);
  const api = resultApi(client);
  const list = await ('run' in query
    ? api.listByRun(query.run, query.statuses)
    : api.listByTest(query.test, {
        statuses: query.statuses,
        env: query.env,
        limit: query.limit,
      }));
  makeOutput(opts, deps).print(list, data => renderResultList(data as ResultList));
  if (opts.output !== 'text') return list;
  const stderr = stderrOf(deps);
  // Only a test's history is cut by the plan's window; a run is listed whole.
  const note =
    'test' in query
      ? historyRetentionNote(
          { hiddenCount: list.hiddenRunCount, retentionDays: list.retentionDays },
          client.resolvedBaseUrl,
          'result',
        )
      : undefined;
  // The server leaves cancelled results out unless `status` names them, so an
  // empty list may be one whose only results were cancelled. When the plan's
  // window hides results, that is the explanation given instead.
  if (list.results.length === 0 && query.statuses === undefined && !note) {
    stderr('If its results were cancelled, list them with --status cancelled.');
  }
  if (note) stderr(note);
  return list;
}

async function runResultGet(
  opts: CommonOptions,
  resultId: string,
  flags: GetFlags,
  deps: ResultDeps,
): Promise<ResultDetail> {
  if (flags.failedOnly && flags.out === undefined) {
    throw localValidationError(
      'failed-only',
      '--failed-only only applies with --out (it narrows what is downloaded). Add --out <dir>, or remove --failed-only',
    );
  }
  if (resultId.trim() === '') {
    throw localValidationError(
      'result-id',
      'cannot be empty or whitespace-only',
      undefined,
      'argument',
    );
  }
  const dir = flags.out === undefined ? undefined : resolveOutDir(flags.out);
  if (dir !== undefined) await assertOutDirParentExists(dir);
  const client = makeClient(opts, deps);
  const detail = await resultApi(client).get(resultId);
  const output = makeOutput(opts, deps);
  if (dir === undefined) {
    output.print(detail, data => renderResultDetail(data as ResultDetail));
    return detail;
  }
  if (opts.dryRun) {
    const planned = planEvidence(detail, flags.failedOnly).map(({ file }) => file);
    const preview: WrittenEvidence = { dir, written: [...planned, RESULT_FILE], failed: [] };
    output.print(preview, data => renderEvidence(data as WrittenEvidence, true));
    return detail;
  }
  // Downloads go straight to storage with the bare fetch: the signed link is
  // the credential, and the API key stays with the API.
  const evidence = await writeEvidence(detail, {
    dir,
    warn: stderrOf(deps),
    failedOnly: flags.failedOnly,
    fetchImpl: deps.fetchImpl,
    stallTimeoutMs: resolveRequestTimeoutMs(opts, deps.env ?? process.env),
  });
  output.print(evidence, data => renderEvidence(data as WrittenEvidence));
  // With no step at all there is nothing to say "every step" of.
  const steps = detail.steps.length + (detail.signIn?.steps.length ?? 0);
  if (flags.failedOnly && opts.output === 'text' && steps > 0 && !hasFailedStep(detail)) {
    stderrOf(deps)('No failed step; downloaded every step.');
  }
  if (evidence.failed.length > 0) throw notDownloaded(resultId, evidence);
  return detail;
}

/** A download that left files out: UNAVAILABLE, as an incomplete download has always been. */
function notDownloaded(resultId: string, evidence: WrittenEvidence): ApiError {
  // The evidence files planned: every one written but result.json, and every one that failed.
  const planned = evidence.written.length - 1 + evidence.failed.length;
  return ApiError.fromEnvelope({
    error: {
      code: 'UNAVAILABLE',
      message: `${evidence.failed.length} of ${planned} evidence files could not be downloaded.`,
      // A failure is not always an expired link (a dead network, a full disk):
      // each file's reason says which.
      nextAction:
        `Run testsprite result get ${resultId} --out <dir> again: each read signs new links. ` +
        "See each file's reason above.",
      requestId: 'local',
      details: { failed: evidence.failed },
    },
  });
}

/** The flags of `result list` as one query, refused (exit 5) before anything is sent. */
function listQuery(flags: ListFlags): ListQuery {
  if (flags.run !== undefined && flags.test !== undefined) {
    throw localValidationError(
      'test',
      '--test and --run are mutually exclusive: pass --test <test-id> or --run <run-id>, not both',
    );
  }
  if (flags.run === undefined && flags.test === undefined) {
    throw localValidationError(
      'test',
      "pass --test <test-id> (one test's results) or --run <run-id> (one run's results)",
    );
  }
  const statuses = flags.status === undefined ? undefined : parseStatuses(flags.status);
  if (flags.run !== undefined) {
    const testOnly =
      flags.env !== undefined ? 'env' : flags.limit !== undefined ? 'limit' : undefined;
    if (testOnly !== undefined) {
      throw localValidationError(
        testOnly,
        `--${testOnly} only applies with --test (it narrows one test's history). Remove --${testOnly}, or list with --test <test-id>`,
      );
    }
    return { run: nonEmpty(flags.run, 'run'), statuses };
  }
  return {
    test: nonEmpty(flags.test!, 'test'),
    statuses,
    env: flags.env === undefined ? undefined : nonEmpty(flags.env, 'env'),
    limit: flags.limit === undefined ? undefined : parseLimit(flags.limit),
  };
}

function nonEmpty(value: string, flag: string): string {
  if (value.trim() === '') throw localValidationError(flag, 'must not be empty');
  return value;
}

/** `--status` values, comma-separated or repeated and in any case, as the server spells them. */
function parseStatuses(values: readonly string[]): string[] {
  const accepted: readonly string[] = ALL_RESULT_STATUSES;
  const named = values
    .flatMap(value => value.split(','))
    .map(status => status.trim().toLowerCase())
    .filter(Boolean);
  const unknown = named.filter(status => !accepted.includes(status));
  if (named.length === 0 || unknown.length > 0) {
    throw localValidationError(
      'status',
      `${unknown.length > 0 ? `unknown status ${unknown.join(', ')}; ` : ''}` +
        `use one or more of: ${accepted.join(', ')}`,
      [...accepted],
    );
  }
  return [...new Set(named)];
}

function parseLimit(raw: string): number {
  const limit = /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!(limit >= 1 && limit <= MAX_LIMIT)) {
    throw localValidationError('limit', `must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function makeClient(opts: CommonOptions, deps: ResultDeps): HttpClient {
  return makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    // A dry run answers from the canned samples, never from an injected fetch.
    fetchImpl: opts.dryRun ? undefined : deps.fetchImpl,
    stderr: deps.stderr,
  });
}

function makeOutput(opts: CommonOptions, deps: ResultDeps): Output {
  return new Output(opts.output, { stdout: deps.stdout, stderr: deps.stderr });
}

function stderrOf(deps: ResultDeps): (line: string) => void {
  return terminalSafeWriter(deps.stderr);
}
