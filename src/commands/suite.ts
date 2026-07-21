import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { Command } from 'commander';
import {
  makeHttpClient,
  parseRequestTimeoutFlag,
  resolveRequestTimeoutMs,
  type CommonOptions,
} from '../lib/client-factory.js';
import {
  ApiError,
  RequestTimeoutError,
  TransportError,
  localValidationError,
} from '../lib/errors.js';
import { createRequestTimeout, type FetchImpl, type HttpClient } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import { paginate, type Page } from '../lib/pagination.js';
import type {
  CliCreateTestResponse,
  CliPutTestCodeResponse,
  CliTest,
  CliTestCode,
  CliUpdateTestResponse,
} from './test.js';

const SUITE_SCHEMA_VERSION = 1;
const LOCK_SCHEMA_VERSION = 1;
const MAX_SUITE_TESTS = 500;
const MAX_CODE_BYTES = 350 * 1024;
const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MANIFEST_FIELDS = new Set(['schemaVersion', 'projectId', 'tests']);
const TEST_FIELDS = new Set([
  'key',
  'testId',
  'name',
  'codeFile',
  'priority',
  'produces',
  'consumes',
  'category',
]);

type Priority = (typeof PRIORITIES)[number];
type SuitePlanAction = 'create' | 'update' | 'noop' | 'conflict';

export interface SuiteTestDefinition {
  key: string;
  testId?: string;
  name: string;
  codeFile: string;
  priority?: Priority;
  produces: string[];
  consumes: string[];
  category?: string;
}

export interface SuiteManifest {
  schemaVersion: typeof SUITE_SCHEMA_VERSION;
  projectId: string;
  tests: SuiteTestDefinition[];
}

export interface SuiteWave {
  wave: number;
  tests: string[];
}

export interface SuiteGraph {
  projectId: string;
  tests: number;
  edges: Array<{ from: string; to: string; variable: string }>;
  waves: SuiteWave[];
  producers: Record<string, string>;
}

interface SuiteLockEntry {
  testId?: string;
  codeVersion?: string | null;
  desiredHash: string;
  createKey?: string;
  updatedAt: string;
}

interface SuiteLock {
  schemaVersion: typeof LOCK_SCHEMA_VERSION;
  projectId: string;
  entries: Record<string, SuiteLockEntry>;
}

export interface SuitePlanItem {
  key: string;
  testId?: string;
  action: SuitePlanAction;
  changes: string[];
  reason?: string;
}

export interface SuitePlan {
  schemaVersion: 1;
  projectId: string;
  manifest: string;
  lockFile: string;
  dryRun: boolean;
  graph: SuiteGraph;
  items: SuitePlanItem[];
  summary: Record<SuitePlanAction, number>;
  unmanagedRemote: string[];
}

export interface SuiteApplyResult {
  projectId: string;
  lockFile: string;
  applied: Array<{ key: string; testId: string; action: 'created' | 'updated' }>;
  unchanged: string[];
  summary: { created: number; updated: number; unchanged: number };
}

export interface SuiteDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  now?: () => Date;
}

interface ManifestContext {
  manifest: SuiteManifest;
  manifestPath: string;
  manifestDir: string;
  lockPath: string;
  codeByKey: Map<string, string>;
  desiredHashByKey: Map<string, string>;
  graph: SuiteGraph;
}

interface ResolvedPlanItem extends SuitePlanItem {
  spec: SuiteTestDefinition;
  desiredCode: string;
  desiredHash: string;
  remote?: CliTest;
  remoteCode?: CliTestCode;
  createKey?: string;
}

interface CalculatedPlan {
  publicPlan: SuitePlan;
  context: ManifestContext;
  lock: SuiteLock;
  items: ResolvedPlanItem[];
}

interface SuiteFileOptions extends CommonOptions {
  manifestPath: string;
  lockFile?: string;
}

interface SuiteApplyOptions extends SuiteFileOptions {
  confirm: boolean;
}

/** Read and fully validate a backend Suitefile, including every referenced code file. */
export function loadSuiteManifest(manifestPath: string, lockFile?: string): ManifestContext {
  const absoluteManifest = resolve(manifestPath);
  const manifestDir = dirname(absoluteManifest);
  const lockPath = resolveLockPath(absoluteManifest, lockFile);
  const raw = stripBom(readTextFile(absoluteManifest, 'manifest'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw localValidationError(
      'manifest',
      `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const errors: string[] = [];
  if (!isRecord(parsed)) {
    throw localValidationError('manifest', 'must be a JSON object');
  }
  rejectUnknownFields(parsed, MANIFEST_FIELDS, 'manifest', errors);
  if (parsed.schemaVersion !== SUITE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SUITE_SCHEMA_VERSION}`);
  }
  const projectId = readRequiredString(parsed.projectId, 'projectId', errors, 200);
  if (!Array.isArray(parsed.tests)) {
    errors.push('tests must be an array');
  } else if (parsed.tests.length === 0 || parsed.tests.length > MAX_SUITE_TESTS) {
    errors.push(`tests must contain between 1 and ${MAX_SUITE_TESTS} entries`);
  }

  const tests: SuiteTestDefinition[] = [];
  const seenKeys = new Set<string>();
  const seenTestIds = new Set<string>();
  if (Array.isArray(parsed.tests)) {
    for (let index = 0; index < parsed.tests.length; index += 1) {
      const value = parsed.tests[index];
      const prefix = `tests[${index}]`;
      if (!isRecord(value)) {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      rejectUnknownFields(value, TEST_FIELDS, prefix, errors);
      const key = readRequiredString(value.key, `${prefix}.key`, errors, 128);
      const name = readRequiredString(value.name, `${prefix}.name`, errors, 200);
      const codeFile = readRequiredString(value.codeFile, `${prefix}.codeFile`, errors, 500);
      const testId = readOptionalString(value.testId, `${prefix}.testId`, errors, 200);
      const priority = readPriority(value.priority, `${prefix}.priority`, errors);
      const produces = readStringArray(value.produces, `${prefix}.produces`, errors);
      const consumes = readStringArray(value.consumes, `${prefix}.consumes`, errors);
      const category = readOptionalString(value.category, `${prefix}.category`, errors, 100);

      if (key && !KEY_PATTERN.test(key)) {
        errors.push(`${prefix}.key must match ${KEY_PATTERN.source}`);
      }
      if (key && seenKeys.has(key)) errors.push(`${prefix}.key duplicates "${key}"`);
      if (key) seenKeys.add(key);
      if (testId && seenTestIds.has(testId)) errors.push(`${prefix}.testId duplicates "${testId}"`);
      if (testId) seenTestIds.add(testId);

      if (key && name && codeFile) {
        tests.push({
          key,
          ...(testId ? { testId } : {}),
          name,
          codeFile,
          ...(priority ? { priority } : {}),
          produces,
          consumes,
          ...(category ? { category } : {}),
        });
      }
    }
  }

  if (errors.length > 0) throw manifestValidationError(errors);

  const codeByKey = new Map<string, string>();
  const desiredHashByKey = new Map<string, string>();
  for (const spec of tests) {
    const codePath = resolveContainedCodePath(manifestDir, spec.codeFile, spec.key);
    const code = readCodeFile(codePath, manifestDir, spec.key);
    codeByKey.set(spec.key, code);
    desiredHashByKey.set(spec.key, desiredHash(spec, code));
  }

  const manifest: SuiteManifest = {
    schemaVersion: SUITE_SCHEMA_VERSION,
    projectId,
    tests,
  };
  const graph = buildSuiteGraph(manifest);
  return {
    manifest,
    manifestPath: absoluteManifest,
    manifestDir,
    lockPath,
    codeByKey,
    desiredHashByKey,
    graph,
  };
}

/** Compile produces/consumes declarations into deterministic execution waves. */
export function buildSuiteGraph(manifest: SuiteManifest): SuiteGraph {
  const errors: string[] = [];
  const producers = new Map<string, string>();
  for (const test of manifest.tests) {
    for (const variable of test.produces) {
      const existing = producers.get(variable);
      if (existing !== undefined && existing !== test.key) {
        errors.push(`variable "${variable}" has ambiguous producers: ${existing}, ${test.key}`);
      } else {
        producers.set(variable, test.key);
      }
    }
  }

  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  const edges: Array<{ from: string; to: string; variable: string }> = [];
  for (const test of manifest.tests) {
    outgoing.set(test.key, new Set());
    indegree.set(test.key, 0);
  }
  for (const test of manifest.tests) {
    for (const variable of test.consumes) {
      const producer = producers.get(variable);
      if (producer === undefined) {
        errors.push(`${test.key} consumes "${variable}" but no suite test produces it`);
        continue;
      }
      if (producer === test.key) {
        errors.push(`${test.key} both produces and consumes "${variable}"`);
        continue;
      }
      addGraphEdge(producer, test.key, variable, outgoing, indegree, edges);
    }
  }

  // Teardown/cleanup tests are compiled into the final wave, matching the
  // backend wave planner's category contract even when they declare no inputs.
  const teardownKeys = new Set(
    manifest.tests
      .filter(test => ['teardown', 'cleanup'].includes(test.category?.toLowerCase() ?? ''))
      .map(test => test.key),
  );
  for (const teardown of teardownKeys) {
    for (const test of manifest.tests) {
      if (test.key !== teardown && !teardownKeys.has(test.key)) {
        addGraphEdge(test.key, teardown, '$teardown', outgoing, indegree, edges);
      }
    }
  }

  if (errors.length > 0) throw manifestValidationError(errors);

  const waves: SuiteWave[] = [];
  const remaining = new Map(indegree);
  let ready = [...remaining.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([key]) => key)
    .sort();
  let visited = 0;
  while (ready.length > 0) {
    waves.push({ wave: waves.length + 1, tests: ready });
    visited += ready.length;
    const next = new Set<string>();
    for (const key of ready) {
      for (const dependent of outgoing.get(key) ?? []) {
        const degree = (remaining.get(dependent) ?? 0) - 1;
        remaining.set(dependent, degree);
        if (degree === 0) next.add(dependent);
      }
    }
    ready = [...next].sort();
  }
  if (visited !== manifest.tests.length) {
    const cycle = [...remaining.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([key]) => key)
      .sort();
    throw manifestValidationError([`dependency cycle detected among: ${cycle.join(', ')}`]);
  }

  return {
    projectId: manifest.projectId,
    tests: manifest.tests.length,
    edges: edges.sort((a, b) =>
      `${a.from}:${a.to}:${a.variable}`.localeCompare(`${b.from}:${b.to}:${b.variable}`),
    ),
    waves,
    producers: Object.fromEntries([...producers.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

export async function runSuiteValidate(
  opts: SuiteFileOptions,
  deps: SuiteDeps = {},
): Promise<{ valid: true; manifest: string; lockFile: string; graph: SuiteGraph }> {
  const context = loadSuiteManifest(opts.manifestPath, opts.lockFile);
  const result = {
    valid: true as const,
    manifest: context.manifestPath,
    lockFile: context.lockPath,
    graph: context.graph,
  };
  makeOutput(opts.output, deps).print(result, () => renderValidationText(result));
  return result;
}

export async function runSuiteGraph(
  opts: SuiteFileOptions,
  deps: SuiteDeps = {},
): Promise<SuiteGraph> {
  const context = loadSuiteManifest(opts.manifestPath, opts.lockFile);
  makeOutput(opts.output, deps).print(context.graph, data => renderGraphText(data as SuiteGraph));
  return context.graph;
}

export async function runSuitePlan(
  opts: SuiteFileOptions,
  deps: SuiteDeps = {},
): Promise<SuitePlan> {
  const calculated = await calculateSuitePlan(opts, deps);
  makeOutput(opts.output, deps).print(calculated.publicPlan, data =>
    renderPlanText(data as SuitePlan),
  );
  return calculated.publicPlan;
}

export async function runSuiteApply(
  opts: SuiteApplyOptions,
  deps: SuiteDeps = {},
): Promise<SuiteApplyResult | SuitePlan> {
  const calculated = await calculateSuitePlan(opts, deps);
  const out = makeOutput(opts.output, deps);
  if (opts.dryRun) {
    out.print(calculated.publicPlan, data => renderPlanText(data as SuitePlan));
    return calculated.publicPlan;
  }
  const conflicts = calculated.items.filter(item => item.action === 'conflict');
  if (conflicts.length > 0) {
    throw localValidationError(
      'suite',
      `plan contains ${conflicts.length} conflict(s): ${conflicts.map(item => item.key).join(', ')}`,
    );
  }
  const mutations = calculated.items.filter(
    item => item.action === 'create' || item.action === 'update',
  );
  if (mutations.length > 0 && !opts.confirm) {
    throw localValidationError(
      'confirm',
      `required to apply ${mutations.length} suite mutation(s); inspect \`testsprite suite plan ${opts.manifestPath}\` first`,
    );
  }

  const client = makeClient(opts, deps);
  const lock = calculated.lock;
  const applied: SuiteApplyResult['applied'] = [];
  const unchanged: string[] = [];
  for (const item of calculated.items) {
    if (item.action === 'noop') {
      unchanged.push(item.key);
      if (item.testId) {
        const existing = lock.entries[item.key];
        const meaningfulFieldsMatch =
          existing?.testId === item.testId &&
          existing.codeVersion === item.remoteCode?.codeVersion &&
          existing.desiredHash === item.desiredHash;
        if (!meaningfulFieldsMatch) {
          lock.entries[item.key] = makeCompletedLockEntry(
            item.testId,
            item.remoteCode?.codeVersion,
            item.desiredHash,
            deps,
          );
        }
      }
      continue;
    }
    if (item.action === 'create') {
      const createKey =
        item.createKey ??
        suiteIdempotencyKey('create', calculated.context.manifest.projectId, item);
      lock.entries[item.key] = {
        desiredHash: item.desiredHash,
        createKey,
        updatedAt: nowIso(deps),
      };
      writeSuiteLock(calculated.context.lockPath, lock);
      const created = await client.post<CliCreateTestResponse>('/tests', {
        body: createBody(calculated.context.manifest.projectId, item.spec, item.desiredCode),
        headers: { 'idempotency-key': createKey },
      });
      lock.entries[item.key] = makeCompletedLockEntry(
        created.testId,
        created.codeVersion,
        item.desiredHash,
        deps,
      );
      writeSuiteLock(calculated.context.lockPath, lock);
      applied.push({ key: item.key, testId: created.testId, action: 'created' });
      continue;
    }
    if (item.action === 'update' && item.testId) {
      let codeVersion = item.remoteCode?.codeVersion;
      const metadataBody = updateMetadataBody(item);
      if (Object.keys(metadataBody).length > 0) {
        await client.put<CliUpdateTestResponse>(`/tests/${encodeURIComponent(item.testId)}`, {
          body: metadataBody,
          headers: {
            'idempotency-key': suiteIdempotencyKey(
              'metadata',
              calculated.context.manifest.projectId,
              item,
            ),
          },
        });
      }
      if (item.changes.includes('code')) {
        const updatedCode = await client.put<CliPutTestCodeResponse>(
          `/tests/${encodeURIComponent(item.testId)}/code`,
          {
            body: { code: item.desiredCode, language: 'python' },
            headers: {
              'idempotency-key': suiteIdempotencyKey(
                'code',
                calculated.context.manifest.projectId,
                item,
              ),
              'if-match': codeVersion ?? '*',
            },
          },
        );
        codeVersion = updatedCode.codeVersion;
      }
      lock.entries[item.key] = makeCompletedLockEntry(
        item.testId,
        codeVersion,
        item.desiredHash,
        deps,
      );
      writeSuiteLock(calculated.context.lockPath, lock);
      applied.push({ key: item.key, testId: item.testId, action: 'updated' });
    }
  }
  writeSuiteLock(calculated.context.lockPath, lock);
  const result: SuiteApplyResult = {
    projectId: calculated.context.manifest.projectId,
    lockFile: calculated.context.lockPath,
    applied,
    unchanged,
    summary: {
      created: applied.filter(item => item.action === 'created').length,
      updated: applied.filter(item => item.action === 'updated').length,
      unchanged: unchanged.length,
    },
  };
  out.print(result, data => renderApplyText(data as SuiteApplyResult));
  return result;
}

export function createSuiteCommand(deps: SuiteDeps = {}): Command {
  const suite = new Command('suite').description(
    'Validate, plan, and apply a declarative backend test suite from a versioned Suitefile',
  );
  suite
    .command('validate <manifest>')
    .description(
      'Validate Suitefile structure, code paths, dependencies, and execution waves locally',
    )
    .option('--lock-file <path>', 'override the adjacent *.lock.json path')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (manifest: string, flags: { lockFile?: string }, command: Command) => {
      await runSuiteValidate(
        { ...resolveCommonOptions(command), manifestPath: manifest, lockFile: flags.lockFile },
        deps,
      );
    });
  suite
    .command('graph <manifest>')
    .description('Compile produces/consumes declarations into deterministic execution waves')
    .option('--lock-file <path>', 'override the adjacent *.lock.json path')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (manifest: string, flags: { lockFile?: string }, command: Command) => {
      await runSuiteGraph(
        { ...resolveCommonOptions(command), manifestPath: manifest, lockFile: flags.lockFile },
        deps,
      );
    });
  suite
    .command('plan <manifest>')
    .description('Compare the Suitefile with the remote project without changing either side')
    .option('--lock-file <path>', 'override the adjacent *.lock.json path')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (manifest: string, flags: { lockFile?: string }, command: Command) => {
      await runSuitePlan(
        { ...resolveCommonOptions(command), manifestPath: manifest, lockFile: flags.lockFile },
        deps,
      );
    });
  suite
    .command('apply <manifest>')
    .description('Create and update backend tests from a previously reviewed Suitefile plan')
    .option('--lock-file <path>', 'override the adjacent *.lock.json path')
    .option('--confirm', 'required before remote mutations; deletions are never performed', false)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        manifest: string,
        flags: { lockFile?: string; confirm?: boolean },
        command: Command,
      ) => {
        await runSuiteApply(
          {
            ...resolveCommonOptions(command),
            manifestPath: manifest,
            lockFile: flags.lockFile,
            confirm: flags.confirm === true,
          },
          deps,
        );
      },
    );
  return suite;
}

async function calculateSuitePlan(
  opts: SuiteFileOptions,
  deps: SuiteDeps,
): Promise<CalculatedPlan> {
  const context = loadSuiteManifest(opts.manifestPath, opts.lockFile);
  const lock = loadSuiteLock(context.lockPath, context.manifest.projectId);
  assertManifestLockAgreement(context.manifest, lock);

  if (opts.dryRun) {
    const items = context.manifest.tests.map((spec): ResolvedPlanItem => {
      const entry = lock.entries[spec.key];
      const testId = spec.testId ?? entry?.testId;
      const desiredHashValue = context.desiredHashByKey.get(spec.key)!;
      return {
        key: spec.key,
        ...(testId ? { testId } : {}),
        action: testId ? 'update' : 'create',
        changes: testId ? ['remote state not inspected in --dry-run'] : ['new backend test'],
        reason: '--dry-run validates local files but intentionally skips credentials and network',
        spec,
        desiredCode: context.codeByKey.get(spec.key)!,
        desiredHash: desiredHashValue,
        ...(entry?.createKey ? { createKey: entry.createKey } : {}),
      };
    });
    return assemblePlan(context, lock, items, [], true);
  }

  const client = makeClient(opts, deps);
  const remotePage = await paginate<CliTest>(
    ({ pageSize, cursor }) =>
      client.get<Page<CliTest>>('/tests', {
        query: { projectId: context.manifest.projectId, pageSize, cursor },
      }),
    { pageSize: 100 },
  );
  const remoteById = new Map(remotePage.items.map(test => [test.id, test] as const));
  const remoteByName = new Map<string, CliTest[]>();
  for (const remote of remotePage.items) {
    const key = remote.name.toLowerCase();
    remoteByName.set(key, [...(remoteByName.get(key) ?? []), remote]);
  }

  const claimedRemoteIds = new Set<string>();
  const items: ResolvedPlanItem[] = [];
  const requestTimeoutMs = resolveRequestTimeoutMs(opts, deps.env ?? process.env);
  for (const spec of context.manifest.tests) {
    const desiredCode = context.codeByKey.get(spec.key)!;
    const desiredHashValue = context.desiredHashByKey.get(spec.key)!;
    const entry = lock.entries[spec.key];
    const testId = spec.testId ?? entry?.testId;
    if (!testId) {
      if (entry?.createKey) {
        if (entry.desiredHash === desiredHashValue) {
          items.push({
            key: spec.key,
            action: 'create',
            changes: ['resume pending idempotent create'],
            reason: 'a prior apply recorded create intent but did not record the server response',
            spec,
            desiredCode,
            desiredHash: desiredHashValue,
            createKey: entry.createKey,
          });
        } else {
          items.push({
            key: spec.key,
            action: 'conflict',
            changes: [],
            reason:
              'the Suitefile changed after a create request became pending; restore the previous definition or inspect and remove the pending lock entry explicitly',
            spec,
            desiredCode,
            desiredHash: desiredHashValue,
          });
        }
        continue;
      }
      const sameName = remoteByName.get(spec.name.toLowerCase()) ?? [];
      if (sameName.length > 0) {
        items.push({
          key: spec.key,
          action: 'conflict',
          changes: [],
          reason: `remote test name already exists (${sameName.map(test => test.id).join(', ')}); add testId or restore the lock entry to adopt it explicitly`,
          spec,
          desiredCode,
          desiredHash: desiredHashValue,
        });
      } else {
        items.push({
          key: spec.key,
          action: 'create',
          changes: ['new backend test'],
          spec,
          desiredCode,
          desiredHash: desiredHashValue,
        });
      }
      continue;
    }
    if (claimedRemoteIds.has(testId)) {
      items.push({
        key: spec.key,
        testId,
        action: 'conflict',
        changes: [],
        reason: `remote test ${testId} is already claimed by another suite key`,
        spec,
        desiredCode,
        desiredHash: desiredHashValue,
      });
      continue;
    }
    claimedRemoteIds.add(testId);
    const remote = remoteById.get(testId);
    if (!remote) {
      items.push({
        key: spec.key,
        testId,
        action: 'conflict',
        changes: [],
        reason: `locked remote test ${testId} was not found in project ${context.manifest.projectId}`,
        spec,
        desiredCode,
        desiredHash: desiredHashValue,
      });
      continue;
    }
    if (remote.type !== 'backend') {
      items.push({
        key: spec.key,
        testId,
        action: 'conflict',
        changes: [],
        reason: `remote test ${testId} is ${remote.type}; Suitefile MVP manages backend tests only`,
        spec,
        desiredCode,
        desiredHash: desiredHashValue,
        remote,
      });
      continue;
    }
    const remoteCode = await client.get<CliTestCode>(`/tests/${encodeURIComponent(testId)}/code`);
    const remoteCodeBody = await resolveRemoteCode(
      remoteCode.code,
      deps.fetchImpl,
      requestTimeoutMs,
    );
    const changes = diffSuiteTest(spec, desiredCode, remote, remoteCodeBody);
    items.push({
      key: spec.key,
      testId,
      action: changes.length > 0 ? 'update' : 'noop',
      changes,
      spec,
      desiredCode,
      desiredHash: desiredHashValue,
      remote,
      remoteCode,
    });
  }
  const unmanagedRemote = remotePage.items
    .filter(test => !claimedRemoteIds.has(test.id))
    .map(test => test.id)
    .sort();
  return assemblePlan(context, lock, items, unmanagedRemote, false);
}

function assemblePlan(
  context: ManifestContext,
  lock: SuiteLock,
  items: ResolvedPlanItem[],
  unmanagedRemote: string[],
  dryRun: boolean,
): CalculatedPlan {
  const summary: Record<SuitePlanAction, number> = { create: 0, update: 0, noop: 0, conflict: 0 };
  for (const item of items) summary[item.action] += 1;
  const publicPlan: SuitePlan = {
    schemaVersion: 1,
    projectId: context.manifest.projectId,
    manifest: context.manifestPath,
    lockFile: context.lockPath,
    dryRun,
    graph: context.graph,
    items: items.map(
      ({
        spec: _spec,
        desiredCode: _code,
        desiredHash: _hash,
        remote: _remote,
        remoteCode: _remoteCode,
        createKey: _createKey,
        ...item
      }) => item,
    ),
    summary,
    unmanagedRemote,
  };
  return { publicPlan, context, lock, items };
}

function diffSuiteTest(
  spec: SuiteTestDefinition,
  desiredCode: string,
  remote: CliTest,
  remoteCode: string,
): string[] {
  const changes: string[] = [];
  if (remote.name !== spec.name) changes.push('name');
  if (spec.priority !== undefined && (remote.priority ?? null) !== spec.priority)
    changes.push('priority');
  if (!sameStringSet(remote.produces ?? [], spec.produces)) changes.push('produces');
  if (!sameStringSet(remote.consumes ?? [], spec.consumes)) changes.push('consumes');
  if (spec.category !== undefined && (remote.category ?? null) !== spec.category)
    changes.push('category');
  if (normalizeNewlines(remoteCode) !== normalizeNewlines(desiredCode)) changes.push('code');
  return changes;
}

function updateMetadataBody(item: ResolvedPlanItem): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (item.changes.includes('name')) body.name = item.spec.name;
  if (item.changes.includes('priority')) body.priority = item.spec.priority;
  if (item.changes.includes('produces')) body.produces = item.spec.produces;
  if (item.changes.includes('consumes')) body.consumes = item.spec.consumes;
  if (item.changes.includes('category')) body.category = item.spec.category;
  return body;
}

function createBody(
  projectId: string,
  spec: SuiteTestDefinition,
  code: string,
): Record<string, unknown> {
  return {
    projectId,
    type: 'backend',
    name: spec.name,
    code,
    ...(spec.priority ? { priority: spec.priority } : {}),
    ...(spec.produces.length > 0 ? { produces: spec.produces } : {}),
    ...(spec.consumes.length > 0 ? { consumes: spec.consumes } : {}),
    ...(spec.category ? { category: spec.category } : {}),
  };
}

async function resolveRemoteCode(
  code: string,
  fetchImpl: FetchImpl | undefined,
  requestTimeoutMs: number,
): Promise<string> {
  if (!code.startsWith('https://')) return code;
  const requestTimeout = createRequestTimeout(requestTimeoutMs);
  try {
    const response = await (fetchImpl ?? globalThis.fetch)(code, {
      signal: requestTimeout.signal,
    });
    if (!response.ok) {
      throw localValidationError(
        'suite',
        `failed to download remote test code (HTTP ${response.status})`,
      );
    }
    return await response.text();
  } catch (error) {
    if (error instanceof ApiError || error instanceof RequestTimeoutError) throw error;
    if (requestTimeout.signal.aborted) {
      throw new RequestTimeoutError(requestTimeoutMs);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new TransportError(`Failed to download remote test code: ${message}`);
  } finally {
    requestTimeout.clear();
  }
}

function loadSuiteLock(path: string, projectId: string): SuiteLock {
  if (!existsSync(path)) return { schemaVersion: LOCK_SCHEMA_VERSION, projectId, entries: {} };
  const raw = readTextFile(path, 'lock-file');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw localValidationError(
      'lock-file',
      `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== LOCK_SCHEMA_VERSION ||
    !isRecord(parsed.entries)
  ) {
    throw localValidationError(
      'lock-file',
      `must use schemaVersion ${LOCK_SCHEMA_VERSION} and contain entries`,
    );
  }
  if (parsed.projectId !== projectId) {
    throw localValidationError(
      'lock-file',
      `belongs to project ${String(parsed.projectId)}, not ${projectId}`,
    );
  }
  const entries: Record<string, SuiteLockEntry> = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (
      !isRecord(value) ||
      typeof value.desiredHash !== 'string' ||
      typeof value.updatedAt !== 'string'
    ) {
      throw localValidationError('lock-file', `entry ${key} is malformed`);
    }
    entries[key] = {
      ...(typeof value.testId === 'string' ? { testId: value.testId } : {}),
      ...(typeof value.codeVersion === 'string' || value.codeVersion === null
        ? { codeVersion: value.codeVersion }
        : {}),
      desiredHash: value.desiredHash,
      ...(typeof value.createKey === 'string' ? { createKey: value.createKey } : {}),
      updatedAt: value.updatedAt,
    };
  }
  return { schemaVersion: LOCK_SCHEMA_VERSION, projectId, entries };
}

function writeSuiteLock(path: string, lock: SuiteLock): void {
  const parent = dirname(path);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw localValidationError('lock-file', `parent directory does not exist: ${parent}`);
  }
  const tmp = resolve(parent, `.${basename(path)}.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, path);
  } catch (error) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw localValidationError(
      'lock-file',
      `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertManifestLockAgreement(manifest: SuiteManifest, lock: SuiteLock): void {
  const errors: string[] = [];
  for (const spec of manifest.tests) {
    const lockedId = lock.entries[spec.key]?.testId;
    if (spec.testId && lockedId && spec.testId !== lockedId) {
      errors.push(
        `${spec.key} declares testId ${spec.testId}, but the lock file records ${lockedId}`,
      );
    }
  }
  if (errors.length > 0) throw manifestValidationError(errors);
}

function makeCompletedLockEntry(
  testId: string,
  codeVersion: string | null | undefined,
  desiredHashValue: string,
  deps: SuiteDeps,
): SuiteLockEntry {
  return {
    testId,
    ...(codeVersion !== undefined ? { codeVersion } : {}),
    desiredHash: desiredHashValue,
    updatedAt: nowIso(deps),
  };
}

function suiteIdempotencyKey(action: string, projectId: string, item: ResolvedPlanItem): string {
  const material = [
    projectId,
    item.key,
    item.testId ?? '',
    item.remoteCode?.codeVersion ?? '',
    item.desiredHash,
  ].join('\0');
  const digest = createHash('sha256').update(material).digest('hex').slice(0, 32);
  return `cli-suite-v1-${action}-${digest}`;
}

function desiredHash(spec: SuiteTestDefinition, code: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        name: spec.name,
        priority: spec.priority ?? null,
        produces: [...spec.produces].sort(),
        consumes: [...spec.consumes].sort(),
        category: spec.category ?? null,
        code: normalizeNewlines(code),
      }),
    )
    .digest('hex');
}

function addGraphEdge(
  from: string,
  to: string,
  variable: string,
  outgoing: Map<string, Set<string>>,
  indegree: Map<string, number>,
  edges: Array<{ from: string; to: string; variable: string }>,
): void {
  const targets = outgoing.get(from)!;
  if (!targets.has(to)) {
    targets.add(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  edges.push({ from, to, variable });
}

function resolveLockPath(manifestPath: string, override?: string): string {
  if (override) return resolve(override);
  return manifestPath.toLowerCase().endsWith('.json')
    ? `${manifestPath.slice(0, -5)}.lock.json`
    : `${manifestPath}.lock.json`;
}

function resolveContainedCodePath(manifestDir: string, codeFile: string, key: string): string {
  if (isAbsolute(codeFile)) {
    throw localValidationError('manifest', `${key}.codeFile must be relative to the Suitefile`);
  }
  const absolute = resolve(manifestDir, codeFile);
  const rel = relative(manifestDir, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw localValidationError('manifest', `${key}.codeFile escapes the Suitefile directory`);
  }
  if (!absolute.toLowerCase().endsWith('.py')) {
    throw localValidationError('manifest', `${key}.codeFile must end in .py for a backend test`);
  }
  return absolute;
}

function readCodeFile(path: string, manifestDir: string, key: string): string {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    throw localValidationError(
      'manifest',
      `${key}.codeFile cannot be read at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!stat.isFile())
    throw localValidationError('manifest', `${key}.codeFile is not a file: ${path}`);
  let realPath: string;
  let realManifestDir: string;
  try {
    realPath = realpathSync(path);
    realManifestDir = realpathSync(manifestDir);
  } catch (error) {
    throw localValidationError(
      'manifest',
      `${key}.codeFile cannot be resolved safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const realRelative = relative(realManifestDir, realPath);
  if (realRelative === '' || realRelative.startsWith('..') || isAbsolute(realRelative)) {
    throw localValidationError(
      'manifest',
      `${key}.codeFile resolves outside the Suitefile directory (symlink escape)`,
    );
  }
  if (stat.size > MAX_CODE_BYTES) {
    throw localValidationError(
      'manifest',
      `${key}.codeFile exceeds the ${MAX_CODE_BYTES}-byte backend limit`,
    );
  }
  const code = stripBom(readTextFile(realPath, 'manifest'));
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw localValidationError(
      'manifest',
      `${key}.codeFile exceeds the ${MAX_CODE_BYTES}-byte backend limit`,
    );
  }
  return code;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function readTextFile(path: string, field: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw localValidationError(
      field,
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readRequiredString(
  value: unknown,
  field: string,
  errors: string[],
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
    return '';
  }
  if (value.length > maxLength) errors.push(`${field} must be at most ${maxLength} characters`);
  return value.trim();
}

function readOptionalString(
  value: unknown,
  field: string,
  errors: string[],
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return readRequiredString(value, field, errors, maxLength) || undefined;
}

function readPriority(value: unknown, field: string, errors: string[]): Priority | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !PRIORITIES.includes(value as Priority)) {
    errors.push(`${field} must be one of: ${PRIORITIES.join(', ')}`);
    return undefined;
  }
  return value as Priority;
}

function readStringArray(value: unknown, field: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of non-empty strings`);
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`${field}[${index}] must be a non-empty string`);
      continue;
    }
    const normalized = item.trim();
    if (normalized.length > 128) errors.push(`${field}[${index}] must be at most 128 characters`);
    if (seen.has(normalized)) errors.push(`${field} contains duplicate "${normalized}"`);
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${field}.${key} is not supported`);
  }
}

function manifestValidationError(errors: string[]): Error {
  return localValidationError('manifest', `${errors.length} problem(s): ${errors.join('; ')}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function nowIso(deps: SuiteDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function resolveCommonOptions(command: Command): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & { requestTimeout?: string };
  return {
    profile: globals.profile ?? 'default',
    output: resolveOutputMode(globals.output),
    dryRun: globals.dryRun ?? false,
    endpointUrl: globals.endpointUrl,
    debug: globals.debug ?? false,
    verbose: globals.verbose ?? false,
    requestTimeoutMs: parseRequestTimeoutFlag(globals.requestTimeout),
  };
}

function makeClient(opts: CommonOptions, deps: SuiteDeps): HttpClient {
  return makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
  });
}

function makeOutput(mode: OutputMode, deps: SuiteDeps): Output {
  return new Output(mode, { stdout: deps.stdout, stderr: deps.stderr });
}

function renderValidationText(result: {
  manifest: string;
  lockFile: string;
  graph: SuiteGraph;
}): string {
  return [
    'Suitefile valid',
    `manifest   ${result.manifest}`,
    `lockFile   ${result.lockFile}`,
    `project    ${result.graph.projectId}`,
    `tests      ${result.graph.tests}`,
    `waves      ${result.graph.waves.length}`,
  ].join('\n');
}

function renderGraphText(graph: SuiteGraph): string {
  const lines = [
    `project ${graph.projectId}`,
    `tests   ${graph.tests}`,
    `waves   ${graph.waves.length}`,
  ];
  for (const wave of graph.waves)
    lines.push(`wave ${String(wave.wave).padStart(2)}  ${wave.tests.join(', ')}`);
  if (graph.edges.length > 0) {
    lines.push('edges');
    for (const edge of graph.edges) lines.push(`  ${edge.from} -> ${edge.to}  [${edge.variable}]`);
  }
  return lines.join('\n');
}

function renderPlanText(plan: SuitePlan): string {
  const lines = [
    `${plan.dryRun ? '[dry-run] ' : ''}Suite plan for ${plan.projectId}`,
    `create ${plan.summary.create}  update ${plan.summary.update}  unchanged ${plan.summary.noop}  conflicts ${plan.summary.conflict}`,
  ];
  for (const item of plan.items) {
    const detail = item.changes.length > 0 ? ` (${item.changes.join(', ')})` : '';
    lines.push(
      `${item.action.padEnd(8)} ${item.key}${item.testId ? ` -> ${item.testId}` : ''}${detail}`,
    );
    if (item.reason) lines.push(`         ${item.reason}`);
  }
  if (plan.unmanagedRemote.length > 0) {
    lines.push(`unmanaged remote tests: ${plan.unmanagedRemote.length} (never deleted)`);
  }
  return lines.join('\n');
}

function renderApplyText(result: SuiteApplyResult): string {
  const lines = [
    `Suite applied to ${result.projectId}`,
    `created ${result.summary.created}  updated ${result.summary.updated}  unchanged ${result.summary.unchanged}`,
    `lockFile ${result.lockFile}`,
  ];
  for (const item of result.applied)
    lines.push(`${item.action.padEnd(8)} ${item.key} -> ${item.testId}`);
  return lines.join('\n');
}
