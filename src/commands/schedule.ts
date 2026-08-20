import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { ApiError } from '../lib/errors.js';
import type { FetchImpl, HttpClient } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import { formatScheduleFrequencyAdvisory, runsPerMonth } from '../lib/cron.js';
import { renderTextTable, type TextTableColumn } from '../lib/text-table.js';
import { assertIdempotencyKey } from '../lib/validate.js';

/** A schedule as returned by the API. */
export interface CliSchedule {
  scheduleId: string;
  name: string;
  enabled: boolean;
  targetType: 'project' | 'testList';
  /** Project id when `targetType` is `project`, else the test-list id. */
  targetId: string | null;
  cron: string | null;
  timezone: string | null;
  startAt: string | null;
  endAt: string | null;
  /** Comma-separated notification recipients. */
  sendTo: string | null;
  /** Set when the schedule was disabled automatically after repeated failures. */
  autoPausedAt: string | null;
  /** Most recent run, or null if it has never run. */
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /schedules` response. Not paginated. */
interface ScheduleListResponse {
  schedules: CliSchedule[];
}

export interface ScheduleDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

type CommonOptions = FactoryCommonOptions;

interface ListOptions extends CommonOptions {
  columns?: string;
  noHeader?: boolean;
}

interface GetOptions extends CommonOptions {
  scheduleId: string;
}

export interface CreateOptions extends CommonOptions {
  name?: string;
  targetType?: string;
  targetId?: string;
  cron?: string;
  timezone?: string;
  start?: string;
  end?: string;
  sendTo?: string;
  idempotencyKey?: string;
}

interface CreateScheduleRequest {
  name: string;
  targetType: 'project' | 'testList';
  targetId: string;
  cron: string;
  timezone?: string;
  startAt?: string;
  endAt?: string;
  sendTo?: string;
}

export interface CliCreateScheduleResponse {
  scheduleId: string;
  /**
   * Approximate credits ONE run of this schedule will consume, as calculated by
   * the API from the target's live case count. `null` when it could not be
   * determined, absent on an API that does not supply it.
   *
   * Per run rather than per month because the API knows the price of a run and
   * this side knows how often the cron fires; neither knows both.
   */
  estimatedCreditsPerRun?: number | null;
}

export interface UpdateOptions extends CommonOptions {
  scheduleId: string;
  name?: string;
  cron?: string;
  timezone?: string;
  start?: string;
  end?: string;
  sendTo?: string;
  pause?: boolean;
  resume?: boolean;
  idempotencyKey?: string;
}

interface UpdateScheduleRequest {
  name?: string;
  enabled?: boolean;
  cron?: string;
  timezone?: string;
  startAt?: string;
  endAt?: string;
  sendTo?: string;
}

export interface DeleteOptions extends CommonOptions {
  scheduleId: string;
  confirm?: boolean;
  idempotencyKey?: string;
}

export interface CliDeleteScheduleResponse {
  scheduleId: string;
}

export interface RunListOptions extends CommonOptions {
  scheduleId: string;
  columns?: string;
  noHeader?: boolean;
}

export interface CliScheduleRun {
  runId: string;
  scheduleId: string | null;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled';
  projectId: string | null;
  testListId: string | null;
  stats: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    running: number;
    cancelled: number;
  };
  createdAt: string;
  updatedAt: string;
}

/** `GET /schedules/{id}/runs` response. Not paginated. */
interface ScheduleRunListResponse {
  runs: CliScheduleRun[];
}

// ---------------------------------------------------------------------------
// schedule list
// ---------------------------------------------------------------------------

export async function runList(
  opts: ListOptions,
  deps: ScheduleDeps = {},
): Promise<ScheduleListResponse> {
  const out = makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);

  const response = await client.get<ScheduleListResponse>('/schedules');
  const schedules = response.schedules ?? [];
  out.print({ schedules }, () =>
    renderScheduleListText(schedules, { columns: opts.columns, noHeader: opts.noHeader }),
  );
  return { schedules };
}

// ---------------------------------------------------------------------------
// schedule get
// ---------------------------------------------------------------------------

export async function runGet(opts: GetOptions, deps: ScheduleDeps = {}): Promise<CliSchedule> {
  const out = makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);

  const schedule = await client.get<CliSchedule>(
    `/schedules/${encodeURIComponent(opts.scheduleId)}`,
  );
  out.print(schedule, data => renderScheduleText(data as CliSchedule));
  return schedule;
}

// ---------------------------------------------------------------------------
// schedule create
// ---------------------------------------------------------------------------

const TARGET_TYPES = ['project', 'testList'] as const;

export async function runCreate(
  opts: CreateOptions,
  deps: ScheduleDeps = {},
): Promise<CliCreateScheduleResponse> {
  const out = makeOutput(opts.output, deps);
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  assertIdempotencyKey(opts.idempotencyKey);

  if (opts.name === undefined || opts.name.trim().length === 0) {
    throw localValidationError('--name is required and must not be empty');
  }
  if (opts.targetType === undefined) {
    throw localValidationError('--target-type is required (project or testList)');
  }
  if (!(TARGET_TYPES as readonly string[]).includes(opts.targetType)) {
    throw localValidationError('--target-type must be one of: project, testList');
  }
  if (opts.targetId === undefined || opts.targetId.trim().length === 0) {
    throw localValidationError('--target-id is required and must not be empty');
  }
  if (opts.cron === undefined || opts.cron.trim().length === 0) {
    throw localValidationError('--cron is required and must not be empty');
  }

  const targetType = opts.targetType as 'project' | 'testList';
  const cron = opts.cron.trim();

  const body: CreateScheduleRequest = {
    name: opts.name,
    targetType,
    targetId: opts.targetId,
    cron,
    ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
    ...(opts.start !== undefined ? { startAt: opts.start } : {}),
    ...(opts.end !== undefined ? { endAt: opts.end } : {}),
    ...(opts.sendTo !== undefined ? { sendTo: opts.sendTo } : {}),
  };

  const idempotencyKey = opts.idempotencyKey ?? `cli-sched-create-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  // Printed before the request so it is visible even if the create then fails.
  stderr(formatScheduleFrequencyAdvisory(cron));

  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    // Carries a cost figure so the advisory below is exercised offline too.
    const sample: CliCreateScheduleResponse = {
      scheduleId: 'sch_dryrun_2026',
      estimatedCreditsPerRun: 5,
    };
    emitCostAdvisory(sample, cron, stderr);
    out.print(sample, data => renderCreateScheduleText(data as CliCreateScheduleResponse));
    return sample;
  }

  const client = makeClient(opts, deps);
  const created = await client.post<CliCreateScheduleResponse>('/schedules', {
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });

  emitCostAdvisory(created, cron, stderr);

  out.print(created, data => renderCreateScheduleText(data as CliCreateScheduleResponse));
  return created;
}

/**
 * Cost advisory for a schedule that was just created.
 *
 * Silent unless the API priced the run — the rates are not exposed, so no figure
 * is invented here. The monthly total is the per-run price times the cron's
 * frequency, and is omitted for an expression this side cannot read.
 */
function emitCostAdvisory(
  response: CliCreateScheduleResponse,
  cron: string,
  stderr: (line: string) => void,
): void {
  const perRun = response.estimatedCreditsPerRun;
  if (typeof perRun !== 'number') return;

  const runs = runsPerMonth(cron);
  const monthly = runs === null ? '' : `, ~${formatMonthly(perRun * runs)} credits/month`;
  stderr(
    `Estimated cost: ~${formatPerRun(perRun)} credits/run${monthly}, ` +
      "based on the target's current case count.",
  );
}

/** Kept to 2 decimals: rounding a per-run price to whole credits stops the monthly total beside it from multiplying out. */
function formatPerRun(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** Whole credits read better for a total; keep decimals only where rounding would say zero. */
function formatMonthly(value: number): string {
  if (value >= 1) return String(Math.round(value));
  return String(Number(value.toFixed(2)));
}

// ---------------------------------------------------------------------------
// schedule update
// ---------------------------------------------------------------------------

export async function runUpdate(
  opts: UpdateOptions,
  deps: ScheduleDeps = {},
): Promise<CliSchedule> {
  const out = makeOutput(opts.output, deps);
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  assertIdempotencyKey(opts.idempotencyKey);

  if (opts.pause && opts.resume) {
    throw localValidationError('--pause and --resume cannot be combined');
  }

  const body: UpdateScheduleRequest = {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.cron !== undefined ? { cron: opts.cron } : {}),
    ...(opts.timezone !== undefined ? { timezone: opts.timezone } : {}),
    ...(opts.start !== undefined ? { startAt: opts.start } : {}),
    ...(opts.end !== undefined ? { endAt: opts.end } : {}),
    ...(opts.sendTo !== undefined ? { sendTo: opts.sendTo } : {}),
    ...(opts.pause ? { enabled: false } : {}),
    ...(opts.resume ? { enabled: true } : {}),
  };

  if (Object.keys(body).length === 0) {
    throw localValidationError('nothing to update — pass at least one field, --pause or --resume');
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-sched-update-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  // Same advisory create prints, for the same reason: retiming a daily schedule
  // to `* * * * *` is the same order-of-magnitude mistake as creating one that
  // way, on an existing schedule and for the same bill. Printed before the
  // request so it is visible even if the update then fails.
  if (opts.cron !== undefined) {
    stderr(formatScheduleFrequencyAdvisory(opts.cron));
  }

  const client = makeClient(opts, deps);
  const updated = await client.patch<CliSchedule>(
    `/schedules/${encodeURIComponent(opts.scheduleId)}`,
    { body, headers: { 'idempotency-key': idempotencyKey } },
  );

  out.print(updated, data => renderScheduleText(data as CliSchedule));
  return updated;
}

// ---------------------------------------------------------------------------
// schedule delete
// ---------------------------------------------------------------------------

export async function runDelete(
  opts: DeleteOptions,
  deps: ScheduleDeps = {},
): Promise<CliDeleteScheduleResponse> {
  const out = makeOutput(opts.output, deps);
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  assertIdempotencyKey(opts.idempotencyKey);

  if (!opts.confirm && !opts.dryRun) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Refusing to delete without --confirm.',
        nextAction:
          'This removes the schedule and its run history, and stops it firing (no ' +
          'restore window — recreating it starts a fresh schedule). The CLI convention ' +
          'is explicit confirmation for destructive operations. Re-run with --confirm. ' +
          '(--dry-run also works without --confirm.)',
        requestId: 'local',
        details: { field: 'confirm', reason: 'required for destructive operation' },
      },
    });
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-sched-delete-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const client = makeClient(opts, deps);
  const deleted = await client.delete<CliDeleteScheduleResponse>(
    `/schedules/${encodeURIComponent(opts.scheduleId)}`,
    { headers: { 'idempotency-key': idempotencyKey } },
  );

  out.print(deleted, data => `deleted: ${(data as CliDeleteScheduleResponse).scheduleId}`);
  return deleted;
}

// ---------------------------------------------------------------------------
// schedule run list
// ---------------------------------------------------------------------------

export async function runRunList(
  opts: RunListOptions,
  deps: ScheduleDeps = {},
): Promise<ScheduleRunListResponse> {
  const out = makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);

  const response = await client.get<ScheduleRunListResponse>(
    `/schedules/${encodeURIComponent(opts.scheduleId)}/runs`,
  );
  const runs = response.runs ?? [];
  out.print({ runs }, () =>
    renderRunListText(runs, { columns: opts.columns, noHeader: opts.noHeader }),
  );
  return { runs };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * `AUTO_PAUSED` is reported separately from `PAUSED` so a schedule the platform
 * turned off after repeated failures is distinguishable from one someone paused
 * with `update --pause`.
 */
function statusOf(s: CliSchedule): string {
  if (s.enabled) return 'ENABLED';
  return s.autoPausedAt ? 'AUTO_PAUSED' : 'PAUSED';
}

const SCHEDULE_LIST_COLUMNS: ReadonlyArray<TextTableColumn<CliSchedule>> = [
  {
    header: 'ID',
    width: rows => Math.max(2, ...rows.map(s => s.scheduleId.length)),
    render: s => s.scheduleId,
  },
  {
    header: 'NAME',
    width: rows => Math.max(4, ...rows.map(s => s.name.length)),
    render: s => s.name,
  },
  { header: 'STATUS', width: 11, render: statusOf },
  { header: 'TARGET', width: 8, render: s => s.targetType },
  {
    header: 'CRON',
    width: rows => Math.max(4, ...rows.map(s => (s.cron ?? '').length)),
    render: s => s.cron ?? '',
  },
  {
    header: 'TZ',
    width: rows => Math.max(2, ...rows.map(s => (s.timezone ?? '').length)),
    render: s => s.timezone ?? '',
  },
  { header: 'LAST RUN', width: 0, render: s => s.lastRunId ?? '' },
];

function renderScheduleListText(
  schedules: readonly CliSchedule[],
  options: { columns?: string; noHeader?: boolean } = {},
): string {
  if (schedules.length === 0) return 'No schedules.';
  return renderTextTable(schedules, SCHEDULE_LIST_COLUMNS, {
    columns: options.columns,
    noHeader: options.noHeader,
  });
}

function renderScheduleText(s: CliSchedule): string {
  const lines = [
    `id:         ${s.scheduleId}`,
    `name:       ${s.name}`,
    `status:     ${statusOf(s)}`,
    `targetType: ${s.targetType}`,
    `targetId:   ${s.targetId ?? '(none)'}`,
    `cron:       ${s.cron ?? '(none)'}`,
    `timezone:   ${s.timezone ?? '(none)'}`,
    `startAt:    ${s.startAt ?? '(none)'}`,
    `endAt:      ${s.endAt ?? '(open-ended)'}`,
    `sendTo:     ${s.sendTo ?? '(none)'}`,
    `lastRunId:  ${s.lastRunId ?? '(never run)'}`,
    `createdAt:  ${s.createdAt}`,
    `updatedAt:  ${s.updatedAt}`,
  ];
  if (s.autoPausedAt) lines.push(`autoPaused: ${s.autoPausedAt}`);
  return lines.join('\n');
}

function renderCreateScheduleText(r: CliCreateScheduleResponse): string {
  return `id: ${r.scheduleId}`;
}

const RUN_LIST_COLUMNS: ReadonlyArray<TextTableColumn<CliScheduleRun>> = [
  {
    header: 'RUN ID',
    width: rows => Math.max(6, ...rows.map(r => r.runId.length)),
    render: r => r.runId,
  },
  { header: 'STATUS', width: 9, render: r => r.status },
  { header: 'TOTAL', width: 5, render: r => String(r.stats.total) },
  { header: 'PASS', width: 4, render: r => String(r.stats.passed) },
  { header: 'FAIL', width: 4, render: r => String(r.stats.failed) },
  { header: 'BLOCK', width: 5, render: r => String(r.stats.blocked) },
  { header: 'STARTED', width: 0, render: r => r.createdAt },
];

function renderRunListText(
  runs: readonly CliScheduleRun[],
  options: { columns?: string; noHeader?: boolean } = {},
): string {
  // Distinct from a missing schedule, which is reported as not found.
  if (runs.length === 0) return 'No runs yet.';
  return renderTextTable(runs, RUN_LIST_COLUMNS, {
    columns: options.columns,
    noHeader: options.noHeader,
  });
}

function localValidationError(message: string): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request.',
      nextAction: message,
      requestId: 'local',
      details: { reason: 'missing_required_flag' },
    },
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function createScheduleCommand(deps: ScheduleDeps = {}): Command {
  const schedule = new Command('schedule').description('Manage TestSprite schedules');

  schedule
    .command('list')
    .description(
      'List schedules visible to the API key\n' +
        '\nExit codes:\n' +
        '  0  success\n' +
        '  3  auth error\n' +
        '  7  schedules are not available on this account\n' +
        ' 10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        ' 13  not available on your plan',
    )
    .option('--columns <list>', 'select/reorder text table columns (comma-separated keys)')
    .option('--no-header', 'suppress the text table header row')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: { columns?: string; header?: boolean }, command: Command) => {
      await runList(
        {
          ...resolveCommonOptions(command),
          columns: cmdOpts.columns,
          noHeader: cmdOpts.header === false,
        },
        deps,
      );
    });

  schedule
    .command('get <schedule-id>')
    .description(
      'Get a schedule by id\n' +
        '\nExit codes:\n' +
        '  0  success\n' +
        '  3  auth error\n' +
        '  4  not found\n' +
        '  7  schedules are not available on this account\n' +
        ' 10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        ' 13  not available on your plan',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (scheduleId: string, _cmdOpts: unknown, command: Command) => {
      await runGet({ ...resolveCommonOptions(command), scheduleId }, deps);
    });

  schedule
    .command('create')
    .description(
      'Create a schedule\n' +
        '\nExit codes:\n' +
        '  0  success\n' +
        '  3  auth error\n' +
        '  4  target not found\n' +
        '  5  validation error (e.g., missing --cron)\n' +
        '  6  idempotency conflict\n' +
        '  7  schedules are not available on this account\n' +
        ' 10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        ' 13  not available on your plan, or the plan limit is reached',
    )
    .option('--name <name>', 'schedule name (required)')
    .option('--target-type <project|testList>', 'what to run (required)')
    .option('--target-id <id>', 'project id or test-list id (required)')
    .option(
      '--cron <expr>',
      'standard 5-field cron (minute hour day-of-month month day-of-week), ' +
        'e.g. "0 3 * * *". Day-of-week is 0-7, with both 0 and 7 = Sunday. ' +
        'Constrain ' +
        'day-of-month or day-of-week, not both. (required)',
    )
    .option('--timezone <tz>', 'IANA timezone (default UTC)')
    .option('--start <iso>', 'ISO 8601 start instant (default: a few minutes from now)')
    .option('--end <iso>', 'ISO 8601 end instant (default: open-ended)')
    .option('--send-to <emails>', 'comma-separated notification recipients')
    .option('--idempotency-key <key>', 'reuse to retry a create safely')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: Record<string, string | undefined>, command: Command) => {
      await runCreate(
        {
          ...resolveCommonOptions(command),
          name: cmdOpts.name,
          targetType: cmdOpts.targetType,
          targetId: cmdOpts.targetId,
          cron: cmdOpts.cron,
          timezone: cmdOpts.timezone,
          start: cmdOpts.start,
          end: cmdOpts.end,
          sendTo: cmdOpts.sendTo,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  schedule
    .command('update <schedule-id>')
    .description(
      'Update a schedule, or pause/resume it\n' +
        '\nExit codes:\n' +
        '  0  success\n' +
        '  3  auth error\n' +
        '  4  not found\n' +
        '  5  validation error (e.g., no fields given)\n' +
        '  6  idempotency conflict\n' +
        '  7  schedules are not available on this account\n' +
        ' 10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        ' 13  not available on your plan',
    )
    .option('--name <name>', 'new schedule name')
    .option(
      '--cron <expr>',
      'new standard 5-field cron, as printed by `schedule get`. Day-of-week is ' +
        '0-7, with both 0 and 7 = Sunday. Constrain day-of-month or day-of-week, not both.',
    )
    .option('--timezone <tz>', 'new IANA timezone')
    .option('--start <iso>', 'new ISO 8601 start instant')
    .option('--end <iso>', 'new ISO 8601 end instant')
    .option('--send-to <emails>', 'comma-separated notification recipients')
    .option('--pause', 'stop the schedule from running')
    .option('--resume', 'let the schedule run again')
    .option('--idempotency-key <key>', 'reuse to retry an update safely')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        scheduleId: string,
        cmdOpts: Record<string, string | boolean | undefined>,
        command: Command,
      ) => {
        await runUpdate(
          {
            ...resolveCommonOptions(command),
            scheduleId,
            name: cmdOpts.name as string | undefined,
            cron: cmdOpts.cron as string | undefined,
            timezone: cmdOpts.timezone as string | undefined,
            start: cmdOpts.start as string | undefined,
            end: cmdOpts.end as string | undefined,
            sendTo: cmdOpts.sendTo as string | undefined,
            pause: cmdOpts.pause === true,
            resume: cmdOpts.resume === true,
            idempotencyKey: cmdOpts.idempotencyKey as string | undefined,
          },
          deps,
        );
      },
    );

  schedule
    .command('delete <schedule-id>')
    .description(
      'Delete a schedule and its run history. Requires --confirm.\n' +
        '\nExit codes:\n' +
        '  0  success\n' +
        '  3  auth error\n' +
        '  4  not found\n' +
        '  5  validation error (e.g., missing --confirm)\n' +
        '  6  idempotency conflict\n' +
        '  7  schedules are not available on this account\n' +
        ' 10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        ' 13  not available on your plan',
    )
    .option('--confirm', 'required: explicit confirmation for the destructive operation', false)
    .option('--idempotency-key <key>', 'reuse to retry a delete safely')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        scheduleId: string,
        cmdOpts: { confirm?: boolean; idempotencyKey?: string },
        command: Command,
      ) => {
        await runDelete(
          {
            ...resolveCommonOptions(command),
            scheduleId,
            confirm: cmdOpts.confirm === true,
            idempotencyKey: cmdOpts.idempotencyKey,
          },
          deps,
        );
      },
    );

  const run = schedule.command('run').description("Inspect a schedule's runs");

  run
    .command('list <schedule-id>')
    .description(
      "List a schedule's past runs\n" +
        '\nExit codes:\n' +
        '  0  success\n' +
        '  3  auth error\n' +
        '  4  not found\n' +
        '  7  schedules are not available on this account\n' +
        ' 10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        ' 13  not available on your plan',
    )
    .option('--columns <list>', 'select/reorder text table columns (comma-separated keys)')
    .option('--no-header', 'suppress the text table header row')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        scheduleId: string,
        cmdOpts: { columns?: string; header?: boolean },
        command: Command,
      ) => {
        await runRunList(
          {
            ...resolveCommonOptions(command),
            scheduleId,
            columns: cmdOpts.columns,
            noHeader: cmdOpts.header === false,
          },
          deps,
        );
      },
    );

  return schedule;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveCommonOptions(command: Command): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & {
    requestTimeout?: string;
  };
  return {
    profile: globals.profile ?? 'default',
    output: resolveOutputMode(globals.output),
    endpointUrl: globals.endpointUrl,
    debug: globals.debug ?? false,
    verbose: globals.verbose ?? false,
    dryRun: globals.dryRun ?? false,
    requestTimeoutMs: parseRequestTimeoutFlag(globals.requestTimeout),
  };
}

function makeClient(opts: CommonOptions, deps: ScheduleDeps): HttpClient {
  return makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
  });
}

function makeOutput(mode: OutputMode, deps: ScheduleDeps): Output {
  return new Output(mode, { stdout: deps.stdout, stderr: deps.stderr });
}
