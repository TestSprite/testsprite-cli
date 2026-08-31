import { promises as nodeFs } from 'node:fs';
import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as path from 'node:path';
import { Command } from 'commander';
import {
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { CLIError, localValidationError } from '../lib/errors.js';
import { loadConfig } from '../lib/config.js';
import { type FetchImpl, type HttpClient } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode } from '../lib/output.js';
import type { Page } from '../lib/pagination.js';
import { assertNotLocal } from '../lib/target-url.js';
import { VERSION } from '../version.js';
import type { CliProject } from './project.js';

// ── constants ────────────────────────────────────────────────────────────────

/** Platforms `ci init` can scaffold. One today; the positional arg leaves room. */
const SUPPORTED_PLATFORMS = ['github'] as const;
type Platform = (typeof SUPPORTED_PLATFORMS)[number];

/** Default location a GitHub Actions workflow must live to be picked up. */
const DEFAULT_WORKFLOW_PATH = '.github/workflows/testsprite.yml';

/** Default terminal-verdict wait, matching the CLI's own `test run` default. */
const DEFAULT_TIMEOUT_SECONDS = 600;

/** The repo secret the generated workflow reads the API key from. */
const API_KEY_SECRET_NAME = 'TESTSPRITE_API_KEY';

/** The published composite action the workflow delegates to, pinned to a tag. */
const ACTION_REF = 'TestSprite/testsprite-action@v1';

/** The CLI's built-in production endpoint (mirrors `config.ts`). Used to decide
 * whether the generated workflow needs an explicit `endpoint-url`. */
const DEFAULT_API_URL = 'https://api.testsprite.com';

// ── deps / options ───────────────────────────────────────────────────────────

/**
 * Minimal fs seam (mirrors `agent.ts`'s `AgentFs` semantics: exclusive writes to
 * refuse clobbering, recursive mkdir to create parent dirs). Kept local so `ci`
 * doesn't couple to the agent-install internals.
 */
export interface CiFs {
  writeFile(target: string, data: string, opts?: { exclusive?: boolean }): Promise<void>;
  mkdir(dir: string): Promise<void>;
  readFile(target: string): Promise<string>;
}

const defaultCiFs: CiFs = {
  // `target`/`dir` are the workflow output path (default `.github/workflows/testsprite.yml`,
  // or the caller's `--path`), resolved from cwd — a scaffold target the user is writing into
  // their own repo, never external/network input. Same risk profile as agent-install scaffolding.
  writeFile: (target, data, opts) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above: caller-supplied scaffold output path, not external input.
    nodeFs.writeFile(target, data, { encoding: 'utf8', flag: opts?.exclusive ? 'wx' : 'w' }),
  mkdir: async dir => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- parent dir of the scaffold output path (above).
    await nodeFs.mkdir(dir, { recursive: true });
  },
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads back the scaffold output path for the --force backup, same path as writeFile.
  readFile: target => nodeFs.readFile(target, 'utf8'),
};

/** Injectable subprocess runner (defaults to a real `spawnSync`), so tests never
 * shell out. Runs `git` (default-branch detection) and `gh` (optional secret set). */
export type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { input?: string; cwd?: string },
) => SpawnSyncReturns<string>;

const defaultSpawn: SpawnImpl = (cmd, args, opts) =>
  nodeSpawnSync(cmd, args, {
    input: opts.input,
    cwd: opts.cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });

export interface CiDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  cwd?: string;
  fs?: CiFs;
  spawn?: SpawnImpl;
}

type CommonOptions = FactoryCommonOptions;

export interface CiInitOptions extends CommonOptions {
  platform: string;
  project?: string;
  filter?: string;
  timeoutSeconds: number;
  workflowPath: string;
  force: boolean;
  setSecret: boolean;
  repo?: string;
}

/** Machine summary emitted under `--output json`. */
export interface CiInitSummary {
  platform: Platform;
  path: string;
  action: string;
  projectId: string;
  wrote: boolean;
  /** Distinguishes the two `wrote: false` cases a scripted caller can't otherwise
   * tell apart: `preview` (a --dry-run) vs `unchanged` (the file was already
   * byte-identical). `written` is the wrote-true case. */
  status: 'written' | 'unchanged' | 'preview';
  backupPath: string | null;
  filter: string | null;
  endpointUrl: string | null;
  endpointWarning: string | null;
  timeoutSeconds: number;
  secret: {
    name: string;
    attempted: boolean;
    set: boolean;
    reason: string | null;
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function resolveCommonOptions(command: Command): CommonOptions {
  const g = command.optsWithGlobals() as Partial<CommonOptions> & { requestTimeout?: string };
  return {
    profile: g.profile ?? 'default',
    output: resolveOutputMode(g.output),
    endpointUrl: g.endpointUrl,
    debug: g.debug ?? false,
    verbose: g.verbose ?? false,
    dryRun: g.dryRun ?? false,
    requestTimeoutMs: parseRequestTimeoutFlag(g.requestTimeout),
  };
}

function makeClient(opts: CommonOptions, deps: CiDeps): HttpClient {
  return makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
  });
}

export function parseTimeoutSeconds(raw: unknown): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 3600) {
    throw localValidationError('timeout', 'must be an integer between 1 and 3600 seconds');
  }
  return n;
}

/**
 * Reject a value that will be interpolated into a double-quoted YAML scalar in
 * the generated workflow. `"` breaks the scalar, a newline breaks the mapping,
 * and `` ` ``/`$` (which also covers `${{ … }}`, evaluated by Actions before the
 * job runs) or `\` could change what the workflow does. A filter is a substring
 * of a test name and a project id/URL never needs any of these, so refusing is
 * safe and keeps the scaffold from ever emitting a workflow GitHub can't parse.
 */
function assertSafeWorkflowValue(
  field: 'filter' | 'project' | 'endpoint-url',
  value: string,
): void {
  if (/[\r\n"`$\\]/.test(value)) {
    throw localValidationError(
      field,
      'must not contain quotes, backticks, $, backslashes, or newlines',
      undefined,
      'field',
    );
  }
}

/**
 * The endpoint the workflow should pin, or undefined for the default production
 * host. Resolved the SAME way the CLI resolves it at runtime (`loadConfig`:
 * flag > TESTSPRITE_API_URL > credentials file > built-in default), so a caller
 * whose profile points at a non-prod backend gets a workflow that targets the
 * same backend their `ci init` just auto-detected the project from — instead of
 * silently emitting a prod workflow that 404s in CI.
 */
function resolveEndpointUrl(opts: CiInitOptions, deps: CiDeps): string | undefined {
  const { apiUrl } = loadConfig({
    profile: opts.profile,
    endpointUrl: opts.endpointUrl,
    env: deps.env,
    credentialsPath: deps.credentialsPath,
  });
  const strip = (u: string) => u.replace(/\/+$/, '');
  return strip(apiUrl) === strip(DEFAULT_API_URL) ? undefined : apiUrl;
}

/**
 * The repo's default branch, so the `push` trigger fires there and not on every
 * feature-branch push (each run costs credits). Best-effort via `git`; falls
 * back to `main` on any failure (not a git repo yet, no `origin`, git absent).
 */
function detectDefaultBranch(cwd: string, spawn: SpawnImpl): string {
  try {
    const res = spawn('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd });
    if (!res.error && res.status === 0) {
      const ref = (res.stdout ?? '').trim().replace(/^origin\//, '');
      if (ref && !/[\r\n"`$\\[\]]/.test(ref)) return ref;
    }
  } catch {
    /* fall through to the default */
  }
  return 'main';
}

/**
 * Build the GitHub Actions workflow. It delegates to the published
 * `TestSprite/testsprite-action` (design A) rather than inlining the CLI, so the
 * partial-run guard (`allow-partial: false` by default), the JUnit upload, the
 * annotations, and the CLI-version pin all come from one maintained place.
 */
export function buildGithubWorkflow(input: {
  projectId: string;
  filter?: string;
  timeoutSeconds: number;
  endpointUrl?: string;
  cliVersion: string;
  defaultBranch: string;
}): string {
  assertSafeWorkflowValue('project', input.projectId);
  if (input.filter) assertSafeWorkflowValue('filter', input.filter);
  if (input.endpointUrl) assertSafeWorkflowValue('endpoint-url', input.endpointUrl);

  const withLines = [
    `          api-key: \${{ secrets.${API_KEY_SECRET_NAME} }}`,
    `          project: "${input.projectId}"`,
    `          cli-version: "${input.cliVersion}"`,
    `          timeout: "${input.timeoutSeconds}"`,
    ...(input.filter ? [`          filter: "${input.filter}"`] : []),
    ...(input.endpointUrl ? [`          endpoint-url: "${input.endpointUrl}"`] : []),
  ];

  return `# Generated by \`testsprite ci init github\`. Gates this repo on TestSprite tests.
# The run, the JUnit report, the annotations, and the skipped-test guard all live
# in ${ACTION_REF}; regenerate with \`testsprite ci init github --force\`.
# Note: tests run against the project's CONFIGURED environment, not this PR's code
# (there is no checkout) — a green check means the tests passed, not that the diff is safe.
name: TestSprite

on:
  push:
    branches: ["${input.defaultBranch}"]
  pull_request:

# The job only needs to read the checkout metadata.
permissions:
  contents: read

jobs:
  testsprite:
    runs-on: ubuntu-latest
    # Fork PRs run without repository secrets, so the API key would be empty and
    # this check permanently red. Skip forks (a maintainer's push still runs it).
    if: \${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}
    steps:
      - uses: ${ACTION_REF}
        with:
${withLines.join('\n')}
`;
}

/**
 * Resolve the project id the workflow pins. An explicit `--project` always wins.
 * Otherwise, list the caller's projects: exactly one ⇒ use it; zero ⇒ ask them to
 * create one; more than one ⇒ ask them to pass `--project` (never guess). Under
 * `--dry-run` we make no network call — a preview uses a placeholder id.
 */
async function resolveProjectId(opts: CiInitOptions, deps: CiDeps): Promise<string> {
  if (opts.project) return opts.project;
  if (opts.dryRun) return '<your-project-id>';

  const client = makeClient(opts, deps);
  // pageSize=2 is enough to distinguish none / exactly-one / more-than-one
  // without paginating: a full page (or a nextToken) means "more than one".
  const page = await client.get<Page<CliProject>>('/projects?pageSize=2');
  const items = page.items ?? [];
  const only = items[0];
  if (!only) {
    throw localValidationError(
      'project',
      'no projects found for this API key — create one (testsprite project create) or pass --project <id>',
    );
  }
  if (items.length > 1 || page.nextToken) {
    throw localValidationError(
      'project',
      'multiple projects found — pass --project <id> to pick one (list them with: testsprite project list)',
    );
  }
  return only.id;
}

/** Walk `<path>.bak`, `.bak.1`, … until a free slot; write the prior content there. */
async function backupExisting(fs: CiFs, target: string, prior: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? `${target}.bak` : `${target}.bak.${i}`;
    try {
      await fs.writeFile(candidate, prior, { exclusive: true });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new CLIError('Could not find a free .bak slot to back up the existing workflow.', 1);
}

/**
 * Optionally set the repo secret via `gh` (soft dependency — never fails the
 * scaffold). Reads the API key from the resolved profile/env and passes it on
 * STDIN (not argv, so it can't leak via the process list). Absent/unauthed `gh`,
 * or a missing key, degrades to the printed instruction. Runs in `cwd` so `gh`
 * infers the right repo when `--repo` is omitted.
 */
function trySetSecret(
  opts: CiInitOptions,
  deps: CiDeps,
  cwd: string,
): { attempted: boolean; set: boolean; reason: string | null } {
  const spawn = deps.spawn ?? defaultSpawn;
  const { apiKey } = loadConfig({
    profile: opts.profile,
    endpointUrl: opts.endpointUrl,
    env: deps.env,
    credentialsPath: deps.credentialsPath,
  });
  if (!apiKey) {
    return { attempted: true, set: false, reason: 'no API key resolved from profile or env' };
  }

  const args = ['secret', 'set', API_KEY_SECRET_NAME];
  if (opts.repo) args.push('--repo', opts.repo);

  let result: SpawnSyncReturns<string>;
  try {
    result = spawn('gh', args, { input: apiKey, cwd });
  } catch (err) {
    return { attempted: true, set: false, reason: `failed to run gh: ${(err as Error).message}` };
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT' ? 'gh CLI not found on PATH' : `gh failed: ${result.error.message}`;
    return { attempted: true, set: false, reason };
  }
  if (result.status !== 0) {
    // gh's stderr can be multi-line and echo back input; keep only the first
    // line so a stray token can never sprawl into the JSON `reason`.
    const stderr = (result.stderr ?? '').split('\n')[0]?.trim() ?? '';
    return {
      attempted: true,
      set: false,
      reason: `gh exited ${result.status}${stderr ? `: ${stderr}` : ''} (is gh authenticated?)`,
    };
  }
  return { attempted: true, set: true, reason: null };
}

// ── orchestrator ─────────────────────────────────────────────────────────────

export async function runCiInit(opts: CiInitOptions, deps: CiDeps = {}): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fs = deps.fs ?? defaultCiFs;
  const spawn = deps.spawn ?? defaultSpawn;
  const cwd = deps.cwd ?? process.cwd();
  const out = new Output(opts.output, { stdout, stderr });

  if (!SUPPORTED_PLATFORMS.includes(opts.platform as Platform)) {
    throw localValidationError(
      'platform',
      `unsupported "${opts.platform}" — supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
      undefined,
      'field',
    );
  }
  const platform = opts.platform as Platform;

  // Validate the caller's own inputs up front — BEFORE the project-list round
  // trip — so a bad --filter/--project fails fast without a wasted request.
  if (opts.filter) assertSafeWorkflowValue('filter', opts.filter);
  if (opts.project) assertSafeWorkflowValue('project', opts.project);

  const projectId = await resolveProjectId(opts, deps);
  const endpointUrl = resolveEndpointUrl(opts, deps);
  const defaultBranch = detectDefaultBranch(cwd, spawn);
  const workflow = buildGithubWorkflow({
    projectId,
    filter: opts.filter,
    timeoutSeconds: opts.timeoutSeconds,
    endpointUrl,
    cliVersion: VERSION,
    defaultBranch,
  });
  const relPath = opts.workflowPath;
  const absPath = path.isAbsolute(relPath) ? relPath : path.join(cwd, relPath);

  // A loopback / private endpoint pinned into a committed workflow is
  // unreachable from a GitHub-hosted runner (the check reds on first push with
  // nothing explaining why). Reuse `assertNotLocal`'s classifier to WARN — not
  // error, since a self-hosted runner legitimately reaches such hosts.
  let endpointWarning: string | null = null;
  if (endpointUrl) {
    try {
      assertNotLocal(endpointUrl);
    } catch {
      endpointWarning = `the workflow pins ${endpointUrl}, which a GitHub-hosted runner cannot reach — pass --endpoint-url <public-url>, or run this workflow on a self-hosted runner.`;
      stderr(`[warn] ${endpointWarning}`);
    }
  }

  const baseSummary = {
    platform,
    path: relPath,
    action: ACTION_REF,
    projectId,
    filter: opts.filter ?? null,
    endpointUrl: endpointUrl ?? null,
    endpointWarning,
    timeoutSeconds: opts.timeoutSeconds,
  };

  // --dry-run: preview to stderr, emit the summary, and make no writes / no gh call.
  if (opts.dryRun) {
    stderr('[dry-run] would write the workflow below — no files changed, no secret set:');
    stderr('');
    for (const line of workflow.split('\n')) stderr(`  ${line}`);
    const summary: CiInitSummary = {
      ...baseSummary,
      wrote: false,
      status: 'preview',
      backupPath: null,
      secret: { name: API_KEY_SECRET_NAME, attempted: false, set: false, reason: null },
    };
    out.print(summary, d => renderCiInitText(d as CiInitSummary));
    return;
  }

  await fs.mkdir(path.dirname(absPath));

  let backupPath: string | null = null;
  let wrote = true;
  try {
    await fs.writeFile(absPath, workflow, { exclusive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EISDIR') {
      throw localValidationError(
        'path',
        `${relPath} is a directory, not a file — pass --path <file> to a writable location`,
        undefined,
        'field',
      );
    }
    if (code !== 'EEXIST') throw err;
    const prior = await fs.readFile(absPath);
    if (prior === workflow) {
      // Already exactly what we'd write — no rewrite, no `.bak` churn. This also
      // makes re-running (with or without --force) on identical content a no-op
      // rather than an error, so it never burns a backup slot.
      wrote = false;
    } else if (!opts.force) {
      throw localValidationError(
        'path',
        `${relPath} already exists — re-run with --force to overwrite (a .bak backup is kept)`,
        undefined,
        'field',
      );
    } else {
      backupPath = await backupExisting(fs, absPath, prior);
      await fs.writeFile(absPath, workflow, { exclusive: false });
    }
  }

  const secret = opts.setSecret
    ? trySetSecret(opts, deps, cwd)
    : { attempted: false, set: false, reason: null };
  if (opts.setSecret && !secret.set) {
    stderr(`[warn] could not set the ${API_KEY_SECRET_NAME} secret (${secret.reason}).`);
  }

  const summary: CiInitSummary = {
    ...baseSummary,
    wrote,
    status: wrote ? 'written' : 'unchanged',
    backupPath: backupPath ? path.relative(cwd, backupPath) : null,
    secret: { name: API_KEY_SECRET_NAME, ...secret },
  };
  out.print(summary, d => renderCiInitText(d as CiInitSummary));
}

// ── text rendering ───────────────────────────────────────────────────────────

export function renderCiInitText(s: CiInitSummary): string {
  const lines: string[] = [];
  const verb =
    s.status === 'written'
      ? `Wrote ${s.path}`
      : s.status === 'preview'
        ? `Would write ${s.path}`
        : `${s.path} is already up to date`;
  lines.push(`${verb} (${s.action}, project ${s.projectId}).`);
  if (s.backupPath) lines.push(`Backed up the previous file to ${s.backupPath}.`);
  lines.push('');
  lines.push('Next steps:');
  if (s.secret.set) {
    lines.push(`  ✓ ${s.secret.name} repo secret set via gh.`);
    lines.push(`  → Commit and push ${s.path}, then open a PR to see the check.`);
  } else {
    lines.push(`  1. Add the ${s.secret.name} repo secret (the workflow reads the key from it):`);
    lines.push(`       gh secret set ${s.secret.name}          # paste your key when prompted`);
    lines.push('     …or in the GitHub UI: Settings → Secrets and variables → Actions.');
    lines.push(`  2. Commit and push ${s.path}, then open a PR to see the check.`);
  }
  return lines.join('\n');
}

// ── command builder ──────────────────────────────────────────────────────────

export function createCiCommand(deps: CiDeps = {}): Command {
  const ci = new Command('ci').description('Scaffold CI integration for TestSprite');

  ci.command('init <platform>')
    .description('Write a CI workflow that runs your TestSprite tests (platform: github)')
    .option('--project <id>', 'project id to run (auto-detected if you have exactly one)')
    .option('--filter <substr>', 'only run tests whose name contains this substring')
    .option(
      '--timeout <s>',
      'max seconds to wait for a terminal verdict (1-3600)',
      String(DEFAULT_TIMEOUT_SECONDS),
    )
    .option('--path <file>', 'output path for the workflow', DEFAULT_WORKFLOW_PATH)
    .option('--force', 'overwrite an existing workflow (a .bak backup is kept)', false)
    .option(
      '--set-secret',
      `set the ${API_KEY_SECRET_NAME} repo secret via gh (if installed + authenticated); OVERWRITES an existing secret of that name`,
      false,
    )
    .option(
      '--repo <owner/name>',
      'target repo for --set-secret (gh infers from the cwd if omitted)',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (platform: string, cmdOpts, command: Command) => {
      const common = resolveCommonOptions(command);
      const opts: CiInitOptions = {
        ...common,
        platform,
        project: cmdOpts.project,
        filter: cmdOpts.filter,
        timeoutSeconds: parseTimeoutSeconds(cmdOpts.timeout),
        workflowPath: cmdOpts.path ?? DEFAULT_WORKFLOW_PATH,
        force: cmdOpts.force ?? false,
        setSecret: cmdOpts.setSecret ?? false,
        repo: cmdOpts.repo,
      };
      await runCiInit(opts, deps);
    });

  return ci;
}
