import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { resolveProfileName } from '../lib/config.js';
import { ApiError, InterruptError } from '../lib/errors.js';
import type { FetchImpl, HttpClient } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import { formatScheduleFrequencyAdvisory, runsPerMonth } from '../lib/cron.js';
import { renderTextTable, type TextTableColumn } from '../lib/text-table.js';
import { assertIdempotencyKey } from '../lib/validate.js';
import { historyRetentionNote, type HistoryRetentionMeta } from '../lib/history-retention.js';

/** A schedule as returned by the API. */
export interface CliSchedule {
  scheduleId: string;
  name: string;
  enabled: boolean;
  targetType: 'project' | 'testList';
  /** Project id when `targetType` is `project`, else the test-list id. */
  targetId: string | null;
  environment?: string | null;
  environmentMode?: 'inherit' | 'pinned' | null;
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
  env?: string;
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
  environment?: string;
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
  /**
   * Echoed back by a server that understands schedule environments — absent
   * entirely on one that doesn't. That absence (not a falsy value) is what
   * `runCreate` uses to detect an old server and refuse instead of confirming
   * a pin that was never applied.
   */
  environment?: string | null;
  environmentMode?: 'inherit' | 'pinned' | null;
}

export interface UpdateOptions extends CommonOptions {
  scheduleId: string;
  name?: string;
  env?: string;
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
  environment?: string;
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
  meta?: HistoryRetentionMeta;
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
  const environment = normalizeScheduleEnvironmentName(opts.env);
  if (targetType === 'testList' && environment !== undefined) {
    throw environmentValidationError(
      'not_supported_for_target',
      `Test-list schedules inherit their list's environment bindings. ` +
        `Use testsprite testlist update ${opts.targetId} ` +
        '--project-env <projectId>:<environmentName> instead.',
    );
  }

  const body: CreateScheduleRequest = {
    name: opts.name,
    targetType,
    targetId: opts.targetId,
    ...(environment !== undefined ? { environment } : {}),
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
    // There is no real server round trip to confirm here, so the mode is
    // synthesized straight from the flags being previewed, same as a
    // compliant server would echo back.
    const sample: CliCreateScheduleResponse = {
      scheduleId: 'sch_dryrun_2026',
      estimatedCreditsPerRun: 5,
      ...(targetType === 'project'
        ? { environment: environment ?? null, environmentMode: environment ? 'pinned' : 'inherit' }
        : {}),
    };
    emitCostAdvisory(sample, cron, stderr);
    out.print(sample, data => renderCreateScheduleText(data as CliCreateScheduleResponse));
    return sample;
  }

  const client = makeClient(opts, deps);
  if (environment !== undefined) {
    await checkScheduleEnvironmentSupport(client);
  }
  const created = await client.post<CliCreateScheduleResponse>('/schedules', {
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });

  if (targetType === 'project' && environment !== undefined) {
    await confirmCreateEnvironmentPin(created, environment, client);
  }

  emitCostAdvisory(created, cron, stderr);

  out.print(created, data => renderCreateScheduleText(data as CliCreateScheduleResponse));
  return created;
}

/**
 * `--env` on create asks the server to pin the new schedule. An old server
 * without this feature drops the field silently and echoes back a schedule
 * with no environment mode at all — printing a confirmation on top of that
 * would claim a pin that was never applied. Instead, best-effort undo the
 * create (this command's own write, seconds old) and refuse.
 */
async function confirmCreateEnvironmentPin(
  created: CliCreateScheduleResponse,
  environment: string,
  client: HttpClient,
): Promise<void> {
  if (created.environmentMode === 'pinned' && created.environment === environment) return;

  let rolledBack = false;
  try {
    await client.delete(`/schedules/${encodeURIComponent(created.scheduleId)}`, {
      headers: { 'idempotency-key': `cli-sched-create-rollback-${randomUUID()}` },
    });
    rolledBack = true;
  } catch (err) {
    if (err instanceof InterruptError) throw err;
  }

  throw unsupportedEnvironmentError(
    rolledBack
      ? `Schedule ${created.scheduleId} was created and then removed because this server did ` +
          'not apply the requested environment.'
      : `Schedule ${created.scheduleId} was created without a confirmed environment pin, and ` +
          'the CLI could not remove it; remove it with: ' +
          `testsprite schedule delete ${created.scheduleId} --confirm`,
    { scheduleId: created.scheduleId, rolledBack },
  );
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
  const environment = normalizeScheduleEnvironmentName(opts.env);

  const body: UpdateScheduleRequest = {
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(environment !== undefined ? { environment } : {}),
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
  if (environment !== undefined && !opts.dryRun) {
    await checkScheduleEnvironmentSupport(client, opts.scheduleId);
  }
  const updated = await client.patch<CliSchedule>(
    `/schedules/${encodeURIComponent(opts.scheduleId)}`,
    { body, headers: { 'idempotency-key': idempotencyKey } },
  );

  // `--env` on update pins an existing schedule. An old server drops the
  // field silently and echoes back no environment mode; unlike create there
  // is nothing to roll back (the schedule pre-existed this command), so this
  // just refuses rather than confirming a pin that was never applied. Other
  // fields in the same request may still have gone through.
  if (
    environment !== undefined &&
    !(updated.environmentMode === 'pinned' && updated.environment === environment)
  ) {
    throw unsupportedEnvironmentError(
      `The server updated schedule ${updated.scheduleId} without confirming the environment ` +
        `pin. Other requested fields (${
          Object.keys(body)
            .filter(key => key !== 'environment')
            .join(', ') || 'none'
        }) ` +
        'may have been applied; inspect it with: ' +
        `testsprite schedule get ${updated.scheduleId}`,
      { scheduleId: updated.scheduleId, requestedFields: Object.keys(body) },
    );
  }

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
  const outputResponse = { ...response, runs };
  out.print(outputResponse, () =>
    renderRunListText(runs, { columns: opts.columns, noHeader: opts.noHeader }),
  );
  if (opts.output === 'text') {
    const note = historyRetentionNote(response.meta, client.resolvedBaseUrl);
    if (note) (deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`)))(note);
  }
  return outputResponse;
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
  {
    header: 'LAST RUN',
    width: rows => Math.max(8, ...rows.map(s => (s.lastRunId ?? '').length)),
    render: s => s.lastRunId ?? '',
  },
  {
    header: 'ENVIRONMENT',
    width: rows => Math.max(11, ...rows.map(s => scheduleEnvironmentText(s).length)),
    render: scheduleEnvironmentText,
  },
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
  if (s.environmentMode !== undefined) {
    lines.push(`environment: ${scheduleEnvironmentText(s)}`);
  }
  return lines.join('\n');
}

/**
 * Renders the environment/mode strictly from the server's response — never
 * from what the command asked for. When the response omits `environmentMode`
 * altogether (an old server that has never heard of schedule environments),
 * this stays silent about it, matching the confirmation text from before the
 * feature existed rather than fabricating a claim the server never made.
 * (A request that explicitly asked to pin and got no confirmation never
 * reaches this renderer — `confirmCreateEnvironmentPin` refuses first.)
 */
function renderCreateScheduleText(r: CliCreateScheduleResponse): string {
  if (r.environmentMode === undefined) return `id: ${r.scheduleId}`;
  return `id: ${r.scheduleId}\nenvironment: ${scheduleEnvironmentText(r)}`;
}

interface ScheduleEnvironmentFields {
  environment?: string | null;
  environmentMode?: 'inherit' | 'pinned' | null;
}

function scheduleEnvironmentText(schedule: ScheduleEnvironmentFields): string {
  if (schedule.environmentMode === 'inherit') return 'project default (inherits)';
  if (schedule.environmentMode === 'pinned' && schedule.environment) {
    return `${schedule.environment} (pinned)`;
  }
  return '-';
}

function normalizeScheduleEnvironmentName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const name = raw.trim();
  if (name.length === 0) {
    throw environmentValidationError('blank_value', '--env must be a non-empty environment name');
  }
  return name;
}

/** A missing mode on a project schedule proves that the server predates pins. */
async function checkScheduleEnvironmentSupport(
  client: HttpClient,
  scheduleId?: string,
): Promise<void> {
  let schedules: CliSchedule[];
  try {
    schedules =
      scheduleId === undefined
        ? ((await client.get<ScheduleListResponse>('/schedules', { retry: false })).schedules ?? [])
        : [
            await client.get<CliSchedule>(`/schedules/${encodeURIComponent(scheduleId)}`, {
              retry: false,
            }),
          ];
  } catch (err) {
    if (err instanceof InterruptError) throw err;
    // A write-scoped key may not read schedules. Keep response confirmation
    // for inconclusive probes and for a server with no existing schedules.
    return;
  }
  if (
    schedules.some(
      schedule => schedule.targetType === 'project' && schedule.environmentMode === undefined,
    )
  ) {
    throw unsupportedEnvironmentError(
      scheduleId === undefined
        ? 'No schedule was created. Upgrade the server before using schedule --env.'
        : `No schedule changes were sent. Upgrade the server before using schedule --env on ${scheduleId}.`,
      {
        ...(scheduleId !== undefined ? { scheduleId } : {}),
        reason: 'schedule-environments-unsupported',
      },
    );
  }
}

/**
 * Local validation failures on `--env` — mirrors the field the API itself
 * uses (`environment`, the wire name) rather than the flag name, so a caller
 * inspecting `details.field` sees the same value whether the rejection was
 * caught locally or came back from the server.
 */
function environmentValidationError(reason: string, nextAction: string): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request.',
      nextAction,
      requestId: 'local',
      details: { field: 'environment', reason },
    },
  });
}

/** Exit 7 — a server that doesn't (yet) support schedule environments. */
function unsupportedEnvironmentError(
  nextAction: string,
  details: Record<string, unknown>,
): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'UNSUPPORTED',
      message: 'This server does not support schedule environments yet.',
      nextAction,
      requestId: 'local',
      details,
    },
  });
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
          ...resolveCommonOptions(command, deps.env),
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
      await runGet({ ...resolveCommonOptions(command, deps.env), scheduleId }, deps);
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
        '  7  schedules are not available on this account, or (with --env) the server does ' +
        'not support schedule environments yet\n' +
        ' 10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        ' 13  not available on your plan, or the plan limit is reached',
    )
    .option('--name <name>', 'schedule name (required)')
    .option('--target-type <project|testList>', 'what to run (required)')
    .option('--target-id <id>', 'project id or test-list id (required)')
    .option(
      '--env <name>',
      "Pin this project schedule to an environment; omit to always use the project's default environment",
    )
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
          ...resolveCommonOptions(command, deps.env),
          name: cmdOpts.name,
          targetType: cmdOpts.targetType,
          targetId: cmdOpts.targetId,
          env: cmdOpts.env,
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
        '  7  schedules are not available on this account, or (with --env) the server does ' +
        'not support schedule environments yet\n' +
        ' 10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        ' 13  not available on your plan',
    )
    .option('--name <name>', 'new schedule name')
    .option(
      '--env <name>',
      "Pin this project schedule to an environment; omit to always use the project's default environment",
    )
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
            ...resolveCommonOptions(command, deps.env),
            scheduleId,
            name: cmdOpts.name as string | undefined,
            env: cmdOpts.env as string | undefined,
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
            ...resolveCommonOptions(command, deps.env),
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
            ...resolveCommonOptions(command, deps.env),
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

function resolveCommonOptions(command: Command, env?: NodeJS.ProcessEnv): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & {
    requestTimeout?: string;
  };
  return {
    profile: resolveProfileName(globals.profile, env),
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
