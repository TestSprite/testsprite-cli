import { promises as nodeFs } from 'node:fs';
import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as path from 'node:path';
import { Command } from 'commander';
import {
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { ApiError, CLIError, localValidationError } from '../lib/errors.js';
import { loadConfig, resolveProfileName } from '../lib/config.js';
import { type FetchImpl, type HttpClient } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import type { Page } from '../lib/pagination.js';
import { assertNotLocal } from '../lib/target-url.js';
import {
  classifyLinkage,
  isValidRepoSlug,
  parseDeploymentsPayload,
  parseRepoSlug,
  type DeploymentRecord,
  type LinkageStatus,
  type LinkageVerdict,
} from '../lib/ci-linkage.js';
import { ciRefusalOutcome, recordTelemetryExtras } from '../lib/telemetry.js';
import type { CliProject } from './project.js';
import { runTestRunAll, type RunTestRunAllOptions, type TestDeps } from './test.js';
import { emitCiStepOutputs, type CiSummary } from '../lib/gh-output.js';
import { previewEnvironmentName, readGithubRunContext } from '../lib/github-context.js';
import type { CiGithubTrigger } from '../lib/runs.types.js';
import { parseJUnitReportFormat } from '../lib/junit-report.js';
import type { CliProjectEnvListResponse } from './project-env.js';

// ── constants ────────────────────────────────────────────────────────────────

/** Platforms `ci init` can scaffold. One today; the positional arg leaves room. */
const SUPPORTED_PLATFORMS = ['github'] as const;
type Platform = (typeof SUPPORTED_PLATFORMS)[number];

/** Default location a GitHub Actions workflow must live to be picked up. */
const DEFAULT_WORKFLOW_PATH = '.github/workflows/testsprite.yml';

/** Where GitHub Actions picks workflows up from; `--path` must stay inside it. */
const WORKFLOWS_DIR = '.github/workflows';

/** Default terminal-verdict wait, matching the CLI's own `test run` default. */
const DEFAULT_TIMEOUT_SECONDS = 600;

/** The repo secret the generated workflow reads the API key from. */
const API_KEY_SECRET_NAME = 'TESTSPRITE_API_KEY';

/**
 * The CLI the generated workflow installs. Always `latest`: what a run means is
 * decided by the backend, which is not versioned with the CLI, so a pinned
 * client only freezes old semantics and is never bumped in practice.
 */
const CLI_PACKAGE_SPEC = '@testsprite/testsprite-cli@latest';

/** The machine summary `ci run` writes, and the artifact the workflow uploads. */
const SUMMARY_FILE = 'testsprite-summary.json';

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
  /** Entry names in `dir`; rejects with ENOENT when the directory is absent. */
  readdir(dir: string): Promise<string[]>;
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads back the scaffold output path (identical-content check) or a sibling workflow in the same dir.
  readFile: target => nodeFs.readFile(target, 'utf8'),
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- lists the workflows dir that holds the scaffold output path.
  readdir: dir => nodeFs.readdir(dir),
};

/** Injectable subprocess runner (defaults to a real `spawnSync`), so tests never
 * shell out. Runs `git` (repo slug), `gh` (optional secret set, deployment
 * history) and `npx vercel` (`ci connect`). */
export type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { input?: string; cwd?: string; shell?: boolean },
) => SpawnSyncReturns<string>;

const defaultSpawn: SpawnImpl = (cmd, args, opts) =>
  nodeSpawnSync(cmd, args, {
    input: opts.input,
    cwd: opts.cwd,
    encoding: 'utf8',
    shell: opts.shell ?? false,
    windowsHide: true,
  });

export interface CiDeps extends Pick<TestDeps, 'shutdown' | 'onWaitTimeout'> {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  cwd?: string;
  fs?: CiFs;
  spawn?: SpawnImpl;
  /** Injected by `ci doctor --wait` tests so polling never really sleeps. */
  sleep?: (ms: number) => Promise<void>;
  /** OS seam for the Windows `npx` shim handling (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
}

type CommonOptions = FactoryCommonOptions;

export interface CiInitOptions extends CommonOptions {
  platform: string;
  project?: string;
  /** `--env`: the environment whose sign-in each PR run uses (default: the project's default). */
  env?: string;
  /** `--timeout`, written into the `ci run` line only when given. */
  timeoutSeconds?: number;
  workflowPath: string;
  force: boolean;
  setSecret: boolean;
  repo?: string;
}

/** Machine summary emitted under `--output json`. */
export interface CiInitSummary {
  platform: Platform;
  path: string;
  projectId: string;
  /** The environment written into `ci run --env`. */
  environment: string;
  wrote: boolean;
  /** Distinguishes the two `wrote: false` cases a scripted caller can't otherwise
   * tell apart: `preview` (a --dry-run) vs `unchanged` (the file was already
   * byte-identical). `written` is the wrote-true case. */
  status: 'written' | 'unchanged' | 'preview';
  endpointUrl: string | null;
  endpointWarning: string | null;
  /** `--timeout` as written into the workflow; null when `ci run`'s default applies. */
  timeoutSeconds: number | null;
  /** Other workflows in `.github/workflows/` that already mention TestSprite. */
  otherTestspriteWorkflows: string[];
  /** `--force` over an edited file: where the previous file was kept. */
  backupPath?: string;
  secret: {
    name: string;
    attempted: boolean;
    set: boolean;
    reason: string | null;
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function resolveCommonOptions(command: Command, env?: NodeJS.ProcessEnv): CommonOptions {
  const g = command.optsWithGlobals() as Partial<CommonOptions> & { requestTimeout?: string };
  return {
    profile: resolveProfileName(g.profile, env),
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

const DEFAULT_EXECUTION_REPORT_TIMEOUT_SECONDS = 60;

/** `--execution-report-timeout <s>`: same bounds as `--timeout`, its own default. */
export function parseExecutionReportTimeoutSeconds(raw: unknown): number {
  if (raw === undefined) return DEFAULT_EXECUTION_REPORT_TIMEOUT_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 3600) {
    throw localValidationError(
      'execution-report-timeout',
      'must be an integer between 1 and 3600 seconds',
    );
  }
  return n;
}

/**
 * Reject a value that will be interpolated into a double-quoted YAML scalar in
 * the generated workflow. `"` breaks the scalar, a newline breaks the mapping,
 * and `` ` ``/`$` (which also covers `${{ … }}`, evaluated by Actions before the
 * job runs) or `\` could change what the workflow does. A project id, an
 * environment name and an endpoint URL never need any of these, so refusing is
 * safe and keeps the scaffold from ever emitting a workflow GitHub can't parse.
 */
function assertSafeWorkflowValue(field: 'project' | 'env' | 'endpoint-url', value: string): void {
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
 * Build the GitHub Actions workflow. It calls the CLI directly (`ci run`), which
 * owns every judgement — waiting, skipped counts, the exit code, the PR
 * context — so the yml only moves data.
 *
 * One template covers both ways a PR gets a preview, because they differ only
 * in where the URL comes from. The trigger, `if:` and concurrency already accept
 * both events; the single placeholder step is the part only the repo owner can
 * write, and it fails loudly until replaced so the gate can never run against a
 * URL nobody chose.
 */
export function buildGithubWorkflow(input: {
  projectId: string;
  environment: string;
  timeoutSeconds?: number;
  endpointUrl?: string;
  workflowPath: string;
}): string {
  assertSafeWorkflowValue('project', input.projectId);
  assertSafeWorkflowValue('env', input.environment);
  if (input.endpointUrl) assertSafeWorkflowValue('endpoint-url', input.endpointUrl);

  const envLines = [
    `      ${API_KEY_SECRET_NAME}: \${{ secrets.${API_KEY_SECRET_NAME} }}`,
    '      # ci run looks up the PR behind a deployment_status event with this token.',
    '      GITHUB_TOKEN: ${{ github.token }}',
    ...(input.endpointUrl ? [`      TESTSPRITE_API_URL: "${input.endpointUrl}"`] : []),
  ];
  const runLines = [
    '          testsprite ci run',
    `          --project "${input.projectId}"`,
    `          --env "${input.environment}"`,
    '          --target-url "$PREVIEW_URL"',
    // A gate must not go green on tests that never ran (a deferred or
    // refused test is "skipped", which only warns by default).
    '          --fail-on-skipped',
    ...(input.timeoutSeconds !== undefined ? [`          --timeout ${input.timeoutSeconds}`] : []),
    `          --summary-file ${SUMMARY_FILE}`,
  ];
  // Leave room for the CLI's own deadline plus install/deploy time.
  const jobMinutes = Math.max(
    45,
    Math.ceil((input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) / 60) + 15,
  );

  return `# Generated by \`testsprite ci init github\`. Regenerate with --force (the previous file is kept as a .bak).
# Runs this project's TestSprite tests against each pull request's preview deployment.
# Before committing, replace the placeholder step marked "REPLACE ME" below.
name: TestSprite

on:
  # B. You deploy in this workflow: keep this trigger.
  # A. Your platform deploys every PR (e.g. the Vercel git integration):
  #    replace the pull_request trigger with \`deployment_status:\`.
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: read

jobs:
  testsprite-tests:
    # B (pull_request): a new push to the pull request cancels the previous job.
    # A (deployment_status): one group per COMMIT — Vercel sets deployment.ref to
    # the commit sha, so a new push does not cancel the previous commit's job.
    # Job-level, so events the if: below drops (pending, inactive, another
    # project's deployment of the same commit) never cancel a running gate.
    # Cancelling only stops this job's CLI: the TestSprite run it started keeps
    # executing and reports in the Portal; the new push starts its own run.
    concurrency:
      group: testsprite-\${{ github.event.pull_request.number || github.event.deployment.sha }}
      cancel-in-progress: true
    # pull_request: skip fork PRs (they get no repository secrets) and draft PRs.
    # deployment_status: only successful, non-production deployments. Vercel leaves
    # production_environment false on production deployments, so the name is checked too
    # (GitHub compares strings case-insensitively).
    # deployment_status runs the workflow file AT THE DEPLOYED COMMIT, with this
    # repository's secrets, and the event does not say whether that commit came
    # from a fork. If your platform deploys pull requests from forks, turn that
    # off there (e.g. Vercel's fork protection) or a fork's edit of this file
    # runs with your TESTSPRITE_API_KEY.
    # A repository that deploys SEVERAL projects (Vercel names them
    # "Preview – <project>") gets one deployment_status per project for the
    # same commit; pin the one to gate by adding
    #   && github.event.deployment.environment == 'Preview – <project>'
    # to the deployment_status branch below.
    if: >-
      (github.event_name == 'pull_request' &&
       github.event.pull_request.head.repo.full_name == github.repository &&
       !github.event.pull_request.draft) ||
      (github.event_name == 'deployment_status' &&
       github.event.deployment_status.state == 'success' &&
       !github.event.deployment.production_environment &&
       github.event.deployment.environment != 'production')
    runs-on: ubuntu-latest
    timeout-minutes: ${jobMinutes}
    env:
${envLines.join('\n')}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - run: npm i -g ${CLI_PACKAGE_SPEC}

      # REPLACE ME — where does this PR's preview URL come from? Pick one:
      # A. Your platform deploys every PR: delete this step (and switch the trigger
      #    above). The next step then reads the URL from the deployment event.
      # B. You deploy in this workflow: replace the run lines with your deploy
      #    commands and end with:  echo "url=<preview address>" >> "$GITHUB_OUTPUT"
      - name: Get this PR's preview URL
        id: preview
        run: |
          echo "::error::Replace the placeholder step in ${input.workflowPath} (see the comment above it)."
          exit 1

      - name: Run TestSprite tests on this PR's preview
        env:
          PREVIEW_URL: \${{ steps.preview.outputs.url || github.event.deployment_status.environment_url }}
        run: >-
${runLines.join('\n')}

      - name: Upload TestSprite report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: testsprite-results
          path: ${SUMMARY_FILE}
          if-no-files-found: ignore
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

/**
 * The environment written into `ci run --env`: its sign-in is what every PR run
 * is cloned from. An explicit `--env` must exist (a typo would otherwise fail
 * on every PR); without one the project's default is named explicitly, so a
 * later change of the default never silently changes what this workflow runs.
 * Under `--dry-run` nothing is looked up, so `authMode` is unknown.
 */
async function resolveEnvironment(
  opts: CiInitOptions,
  deps: CiDeps,
  projectId: string,
): Promise<{ name: string; authMode?: string }> {
  const requested = opts.env?.trim();
  if (opts.env !== undefined && !requested) {
    throw localValidationError(
      'env',
      'must be a non-empty environment name (list them with: testsprite project env list <project-id>)',
    );
  }
  if (opts.dryRun) return { name: requested ?? '<your-env-name>' };

  const client = makeClient(opts, deps);
  const listed = await client.get<CliProjectEnvListResponse>(
    `/projects/${encodeURIComponent(projectId)}/env`,
  );
  const environments = listed.environments ?? [];
  const names = environments.map(e => e.name).join(', ') || '(none)';
  if (requested !== undefined) {
    const match = environments.find(e => e.name === requested);
    if (!match) {
      throw localValidationError(
        'env',
        `no environment named "${requested}" in project ${projectId} — available: ${names}`,
      );
    }
    return { name: match.name, authMode: match.authMode };
  }
  const fallback = environments.find(e => e.isDefault);
  if (!fallback) {
    throw localValidationError(
      'env',
      `project ${projectId} has no default environment — pass --env <name> (available: ${names})`,
    );
  }
  return { name: fallback.name, authMode: fallback.authMode };
}

/**
 * `--path` relative to the repo, with forward slashes. GitHub only runs
 * workflows from `.github/workflows/*.yml|yaml`; anywhere else the file is
 * written and silently never runs, so it is refused.
 */
function resolveWorkflowPath(raw: string, cwd: string): { relPath: string; absPath: string } {
  // `join`, not `resolve`: the latter would prepend the drive letter on
  // Windows and no longer line up with the caller's own `cwd`-based paths.
  const absPath = path.isAbsolute(raw) ? path.normalize(raw) : path.join(cwd, raw);
  const relPath = path.relative(cwd, absPath).split(path.sep).join('/');
  const dir = path.posix.dirname(relPath);
  if (dir !== WORKFLOWS_DIR || !/\.ya?ml$/.test(relPath)) {
    throw localValidationError(
      'path',
      `must be a .yml or .yaml file directly under ${WORKFLOWS_DIR}/ (GitHub never runs a workflow anywhere else)`,
      undefined,
      'field',
    );
  }
  return { relPath, absPath };
}

/**
 * Other workflows that already mention TestSprite (the CLI, or one of our
 * actions). Two gates on one PR run every test twice and are billed twice, so
 * the caller warns; it never blocks, because two workflows can be deliberate.
 */
async function findOtherTestspriteWorkflows(
  fs: CiFs,
  absDir: string,
  absTarget: string,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(absDir);
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const name of entries.sort()) {
    const abs = path.join(absDir, name);
    if (abs === absTarget || !/\.ya?ml$/.test(name)) continue;
    try {
      if (/testsprite/i.test(await fs.readFile(abs))) hits.push(`${WORKFLOWS_DIR}/${name}`);
    } catch {
      /* unreadable or a directory: nothing to report */
    }
  }
  return hits;
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
  if (!SUPPORTED_PLATFORMS.includes(opts.platform as Platform)) {
    throw localValidationError(
      'platform',
      `unsupported "${opts.platform}" — supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
      undefined,
      'field',
    );
  }
  const platform = opts.platform as Platform;

  // Telemetry facts for this invocation (see lib/telemetry.ts — low-cardinality
  // only: never the path, the project id, or the environment name). `workflowExisted` is
  // learned only once the write is attempted, so it is filled in below and the
  // whole set is recorded on every exit path, including a thrown error.
  let workflowExisted: boolean | undefined;
  try {
    await runCiInitScaffold(opts, deps, platform, existed => {
      workflowExisted = existed;
    });
  } finally {
    recordTelemetryExtras({
      platform,
      force: opts.force,
      projectResolved: opts.project ? 'flag' : 'auto',
      ...(workflowExisted !== undefined ? { workflowExisted } : {}),
    });
  }
}

/**
 * The scaffold proper (everything after platform validation). Reports whether a
 * workflow file already existed at the target path via `onExisted` the moment
 * that is known — BEFORE the `--force` decision throws or overwrites. Under
 * `--dry-run` it returns before the write is attempted, so `onExisted` is never
 * called and the fact stays unknown.
 */
async function runCiInitScaffold(
  opts: CiInitOptions,
  deps: CiDeps,
  platform: Platform,
  onExisted: (existed: boolean) => void,
): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fs = deps.fs ?? defaultCiFs;
  const cwd = deps.cwd ?? process.cwd();
  const out = new Output(opts.output, { stdout, stderr });

  // Validate the caller's own inputs up front — BEFORE any round trip — so a
  // bad --project/--env/--path fails fast without a wasted request.
  if (opts.project) assertSafeWorkflowValue('project', opts.project);
  if (opts.env) assertSafeWorkflowValue('env', opts.env);
  const { relPath, absPath } = resolveWorkflowPath(opts.workflowPath, cwd);

  const projectId = await resolveProjectId(opts, deps);
  const resolvedEnv = await resolveEnvironment(opts, deps, projectId);
  const environment = resolvedEnv.name;
  // A recorded (SSO/manual) session is bound to the environment's own address,
  // so it cannot sign in on a preview; the backend refuses those PR runs before
  // charging. Writing the workflow is still allowed — the user may change the
  // environment's sign-in later — but say so now rather than on the first PR.
  if (resolvedEnv.authMode === 'manual') {
    stderr(
      `[warn] environment "${environment}" signs in with a recorded SSO session, which cannot follow a preview's address — PR runs against it will be refused. Prefer an environment with a test account or no sign-in (testsprite project env list ${projectId}).`,
    );
  }
  const endpointUrl = resolveEndpointUrl(opts, deps);
  const workflow = buildGithubWorkflow({
    projectId,
    environment,
    timeoutSeconds: opts.timeoutSeconds,
    endpointUrl,
    workflowPath: relPath,
  });

  // A loopback / private endpoint pinned into a committed workflow is
  // unreachable from a GitHub-hosted runner (the check reds on first push with
  // nothing explaining why). Reuse `assertNotLocal`'s classifier to WARN — not
  // error, since a self-hosted runner legitimately reaches such hosts.
  let endpointWarning: string | null = null;
  if (endpointUrl) {
    try {
      assertNotLocal(endpointUrl, {
        field: 'endpoint-url',
        helpCommand: 'testsprite ci init',
      });
    } catch {
      endpointWarning = `the workflow pins ${endpointUrl}, which a GitHub-hosted runner cannot reach — pass --endpoint-url <public-url>, or run this workflow on a self-hosted runner.`;
      stderr(`[warn] ${endpointWarning}`);
    }
  }

  const otherTestspriteWorkflows = await findOtherTestspriteWorkflows(
    fs,
    path.dirname(absPath),
    absPath,
  );
  if (otherTestspriteWorkflows.length > 0) {
    stderr(
      `[warn] ${otherTestspriteWorkflows.join(', ')} already run${otherTestspriteWorkflows.length === 1 ? 's' : ''} TestSprite — with this workflow too, each PR may run (and be billed for) its tests twice.`,
    );
  }

  const baseSummary = {
    platform,
    path: relPath,
    projectId,
    environment,
    endpointUrl: endpointUrl ?? null,
    endpointWarning,
    timeoutSeconds: opts.timeoutSeconds ?? null,
    otherTestspriteWorkflows,
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
      secret: { name: API_KEY_SECRET_NAME, attempted: false, set: false, reason: null },
    };
    out.print(summary, d => renderCiInitText(d as CiInitSummary));
    return;
  }

  await fs.mkdir(path.dirname(absPath));

  let wrote = true;

  let backupPath: string | null = null;
  try {
    await fs.writeFile(absPath, workflow, { exclusive: true });
    onExisted(false);
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
    onExisted(true);
    const prior = await fs.readFile(absPath);
    if (prior === workflow) {
      // Already exactly what we'd write: no rewrite, and re-running (with or
      // without --force) on identical content is a no-op rather than an error.
      wrote = false;
    } else if (!opts.force) {
      throw localValidationError(
        'path',
        `${relPath} already exists — re-run with --force to overwrite it (git keeps the old version)`,
        undefined,
        'field',
      );
    } else {
      // The template needs a hand edit (the preview step), so a --force to
      // change one flag must not silently discard it: keep the old file.
      backupPath = `${absPath}.bak`;
      await fs.writeFile(backupPath, prior, { exclusive: false });
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
    // Relative like `path`, and forward-slashed on every OS for the same reason.
    ...(backupPath !== null ? { backupPath: `${relPath}.bak` } : {}),
    secret: { name: API_KEY_SECRET_NAME, ...secret },
  };
  out.print(summary, d => renderCiInitText(d as CiInitSummary));
}

// ── ci doctor / ci connect ───────────────────────────────────────────────────

export interface CiDoctorOptions extends CommonOptions {
  repo?: string;
  /** Poll until a NEW deployment record arrives (the post-connect check). */
  wait: boolean;
  /** Bound for `--wait`, in seconds; undefined = `--timeout` was not given. */
  waitTimeoutSeconds?: number;
}

export interface CiDoctorSummary {
  repo: string;
  status: LinkageStatus;
  ok: boolean;
  detail: string;
  lastDeployAt: string | null;
  creators: string[];
  hasPreview: boolean;
  /** Whether this run watched for a new record (`--wait`). */
  waited: boolean;
  /** `--wait` only: the record whose arrival ended the wait, or null. */
  newDeployment: DeploymentRecord | null;
  /** Set when history could not be read at all — then the rest is not a verdict. */
  error: string | null;
}

/** Poll interval for `--wait`. A deploy takes minutes; 15 s keeps it cheap. */
const DOCTOR_POLL_INTERVAL_MS = 15_000;

/**
 * `owner/repo` for the check: the explicit `--repo`, else the `origin` remote.
 * Returns null when neither resolves — the caller turns that into guidance
 * rather than an opaque failure.
 */
export function resolveRepoSlug(
  explicit: string | undefined,
  cwd: string,
  spawn: SpawnImpl,
): string | null {
  if (explicit !== undefined && explicit !== '') {
    return isValidRepoSlug(explicit) ? explicit : null;
  }
  try {
    const res = spawn('git', ['remote', 'get-url', 'origin'], { cwd });
    if (res.error || res.status !== 0) return null;
    return parseRepoSlug(res.stdout ?? '');
  } catch {
    return null;
  }
}

/**
 * Read the repo's deployment history through `gh` — the same soft dependency
 * `--set-secret` already uses, so this adds no new requirement. It carries the
 * user's own GitHub credentials, which a private repo needs.
 */
function fetchDeploymentHistory(
  repo: string,
  cwd: string,
  spawn: SpawnImpl,
): { records: DeploymentRecord[] } | { error: string } {
  let result: SpawnSyncReturns<string>;
  try {
    // 100 (the API maximum) rather than a small page: the classifier separates
    // preview from production records, and a busy repo can push dozens of
    // production deploys past its newest preview — a short page would then read
    // as a false `production-only`.
    result = spawn('gh', ['api', `repos/${repo}/deployments?per_page=100`], { cwd });
  } catch (err) {
    return { error: `failed to run gh: ${(err as Error).message}` };
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      error:
        code === 'ENOENT'
          ? 'gh CLI not found on PATH — install it (https://cli.github.com), then `gh auth login`'
          : `gh failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').split('\n')[0]?.trim() ?? '';
    return { error: `gh exited ${result.status}${stderr ? `: ${stderr}` : ''}` };
  }
  return { records: parseDeploymentsPayload(result.stdout ?? '') };
}

/**
 * Diagnose whether deployment events reach this repo — the precondition every
 * deployment-gated workflow rests on, and the only one that fails *silently*.
 *
 * Exits non-zero when the chain is not live, so a script (or `ci init`) can
 * gate on it. `--wait` makes the post-connect verification one command instead
 * of "go watch GitHub yourself": it baselines the history on the first read and
 * succeeds when a NEW record arrives. That success condition is a hard fact,
 * deliberately independent of the preview/production heuristic — pushing to a
 * default branch produces a *production* deployment, and that still proves the
 * link is live.
 */
export async function runCiDoctor(opts: CiDoctorOptions, deps: CiDeps = {}): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = new Output(opts.output, { stdout, stderr });
  const cwd = deps.cwd ?? process.cwd();
  const spawn = deps.spawn ?? defaultSpawn;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  if (opts.waitTimeoutSeconds !== undefined && !opts.wait) {
    throw localValidationError(
      'timeout',
      'only applies with --wait — add --wait, or drop --timeout',
    );
  }
  const waitTimeoutSeconds = opts.waitTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  const repo = resolveRepoSlug(opts.repo, cwd, spawn);
  if (repo === null) {
    throw localValidationError(
      'repo',
      opts.repo
        ? 'must look like owner/name (e.g. acme/storefront)'
        : 'could not read a GitHub `origin` remote here — run from the repo, or pass --repo <owner/name>',
    );
  }

  const deadline = Date.now() + waitTimeoutSeconds * 1000;
  let verdict: LinkageVerdict | undefined;
  let readError: string | null = null;
  /** Newest record's timestamp on the first successful read; -∞ when it saw none. */
  let baselineNewestMs: number | undefined;
  let newDeployment: DeploymentRecord | null = null;

  for (;;) {
    const budgetLeft = Date.now() + DOCTOR_POLL_INTERVAL_MS <= deadline;
    const history = fetchDeploymentHistory(repo, cwd, spawn);
    if ('error' in history) {
      // A transient `gh` failure (rate limit, network blip) must not abort a
      // ten-minute watch — keep polling while budget remains. It surfaces as
      // exit 10 only when the whole wait ends without one successful read.
      readError = history.error;
      if (!opts.wait || !budgetLeft) break;
      stderr(`[wait] could not read deployment history (${history.error}) — retrying`);
      await sleep(DOCTOR_POLL_INTERVAL_MS);
      continue;
    }
    verdict = classifyLinkage(history.records, new Date());
    if (!opts.wait) break;

    const newestMs = history.records.reduce(
      (max, r) => Math.max(max, new Date(r.createdAt).getTime()),
      Number.NEGATIVE_INFINITY,
    );
    if (baselineNewestMs === undefined) {
      // What already exists only anchors the comparison — `--wait` is about
      // the record the user's connect + push is producing right now.
      baselineNewestMs = newestMs;
    } else if (newestMs > baselineNewestMs) {
      newDeployment =
        history.records.find(r => new Date(r.createdAt).getTime() === newestMs) ?? null;
      break;
    }
    if (!budgetLeft) break;
    stderr(
      `[wait] no new deployment record yet — checking again in ${DOCTOR_POLL_INTERVAL_MS / 1000}s`,
    );
    await sleep(DOCTOR_POLL_INTERVAL_MS);
  }

  // A read failure on the LAST attempt does not erase an earlier verdict; the
  // error only stands when no read ever succeeded.
  const unread = verdict === undefined;
  const summary: CiDoctorSummary = {
    repo,
    status: verdict?.status ?? 'none',
    ok: verdict?.ok ?? false,
    detail: verdict?.detail ?? readError ?? 'could not read deployment history',
    lastDeployAt: verdict?.lastDeployAt ?? null,
    creators: verdict?.creators ?? [],
    hasPreview: verdict?.hasPreview ?? false,
    waited: opts.wait,
    newDeployment,
    error: unread ? readError : null,
  };
  out.print(summary, d => renderCiDoctorText(d as CiDoctorSummary));

  // A read failure is NOT a verdict — reporting "not linked" because `gh` is
  // missing would send the user to fix the wrong thing.
  if (unread) {
    throw new CLIError(`ci doctor: could not read deployment history for ${repo}`, 10);
  }
  // A new record arriving is what `--wait` verifies: events reach this repo.
  // The verdict above still tells the user what KIND of gate that supports.
  if (newDeployment !== null) return;
  if (!summary.ok) {
    throw new CLIError(
      `ci doctor: ${repo} is not ready for a deployment-gated workflow (${summary.status})`,
      1,
    );
  }
}

export function renderCiDoctorText(s: CiDoctorSummary): string {
  const lines: string[] = [];
  const mark = s.error ? '[FAIL]' : s.ok ? '[OK]  ' : '[WARN]';
  lines.push(`${mark} deployment events   ${s.repo}`);
  if (s.newDeployment) {
    const day = s.newDeployment.createdAt.slice(0, 10);
    lines.push(
      `       new deployment record: ${s.newDeployment.environment} (${day}) ✓ — events reach this repo`,
    );
  }
  lines.push(`       ${s.detail}`);
  if (s.error) {
    lines.push('');
    lines.push("Could not read the repo's deployment history, so this is not a verdict:");
    lines.push(`  ${s.error}`);
    return lines.join('\n');
  }
  if (s.waited && !s.newDeployment) {
    lines.push(
      '       (no NEW deployment record arrived while waiting — the verdict above is from the existing history)',
    );
  }
  if (s.ok) return lines.join('\n');

  lines.push('');
  lines.push('Next steps:');
  if (s.status === 'none') {
    lines.push('  1. Link your deploy platform to this repo:');
    lines.push('       testsprite ci connect          # runs `vercel git connect` for you');
    lines.push("     …or link the repo in your platform's dashboard.");
    // A branch, not the default branch: a default-branch push deploys as
    // PRODUCTION, which proves the link but is not what a PR gate keys on.
    lines.push('  2. Push a commit on a branch so a preview deployment lands:');
    lines.push('       git checkout -b verify-testsprite-ci');
    lines.push(
      '       git commit --allow-empty -m "verify testsprite ci" && git push -u origin HEAD',
    );
    lines.push('  3. Confirm the events arrive (any new deployment record counts):');
    lines.push('       testsprite ci doctor --wait');
  } else if (s.status === 'production-only') {
    lines.push('  → Enable preview deployments for pull requests on your deploy platform.');
    lines.push('    A PR gate keys on preview deployments; production-only events fire on');
    lines.push('    releases instead, so the check would never run on a PR.');
  } else {
    lines.push('  → Push a commit and re-run `testsprite ci doctor --wait` to confirm the link');
    lines.push('    is still live before scaffolding a gate on it.');
  }
  lines.push('');
  lines.push('Self-hosted pipeline? Report each deploy yourself, and every path works the same:');
  // `required_contexts: []` is load-bearing: without it GitHub answers 409 when
  // any commit status on the SHA is failing — i.e. exactly when a PR pipeline is
  // deploying its preview. JSON input because `-f` would send the empty array as
  // a string. (Both learned the hard way running this against a real repo.)
  lines.push(
    `  ID=$(printf '{"ref":"%s","environment":"preview","auto_merge":false,"required_contexts":[]}' "$SHA" \\`,
  );
  lines.push(`    | gh api repos/${s.repo}/deployments --input - --jq .id)`);
  lines.push(
    `  gh api repos/${s.repo}/deployments/$ID/statuses -f state=success -f environment_url=$URL`,
  );
  return lines.join('\n');
}

export interface CiConnectOptions extends CommonOptions {
  /** Vercel project to link when this directory is not linked yet. */
  project?: string;
}

export interface CiConnectSummary {
  platform: 'vercel';
  /** The commands that were actually spawned, in order — no secrets in them. */
  ran: string[];
  connected: boolean;
  alreadyConnected: boolean;
  reason: string | null;
}

/**
 * The Vercel CLI, pinned to the major this command's flag semantics were
 * verified against (59.23.2). Unpinned, a breaking Vercel release could change
 * what `--non-interactive` refuses or creates under a tool people run in CI.
 * (Unrelated to the TestSprite CLI's own `latest` policy — this pins a THIRD
 * PARTY whose behavior we shell out to.) Bump deliberately, re-testing the
 * ladder below.
 */
const VERCEL_CLI_SPEC = 'vercel@59';

/** What Vercel accepts as a project name — and all that may reach the Windows
 * shell path below, so keep it strict. */
const VERCEL_PROJECT_NAME_RE = /^[a-z0-9._-]{1,100}$/;

/**
 * `--non-interactive` refusals come back as one JSON object with a `reason`
 * and often a `next[]` of literal commands — relay those, since Vercel's own
 * instructions beat anything we could paraphrase. Anything else falls back to
 * the first non-empty output line.
 */
function vercelFailureDetail(result: SpawnSyncReturns<string>): string {
  for (const chunk of [result.stdout ?? '', result.stderr ?? '']) {
    const trimmed = chunk.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as { reason?: unknown; next?: unknown };
      if (typeof parsed.reason === 'string') {
        const next = Array.isArray(parsed.next)
          ? parsed.next.filter((n): n is string => typeof n === 'string')
          : [];
        return next.length > 0 ? `${parsed.reason} — next: ${next.join(' && ')}` : parsed.reason;
      }
    } catch {
      /* prose after all — fall through */
    }
  }
  return (
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      .split('\n')
      .find(l => l.trim() !== '')
      ?.trim() ?? ''
  );
}

/**
 * Link the deploy platform to the repo — the fix for `ci doctor`'s `none`.
 *
 * Runs the platform's OWN CLI as a subprocess (`npx vercel …`, so nothing needs
 * pre-installing) rather than calling Vercel's API ourselves. That is a
 * deliberate boundary: any other approach would require the user to hand us a
 * Vercel token, and a third-party credential should never pass through this
 * CLI. Vercel's CLI keeps its own credentials; we only read exit codes.
 *
 * Every step runs `--non-interactive`, and `--yes` is NEVER passed to the
 * Vercel CLI on any path. `--yes` does not mean "skip confirmations": on an
 * unlinked directory `vercel link --yes` answers the new-project questions
 * with the default scope and the current directory name — creating a project
 * nobody asked for, which `git connect` then wires the repo to and starts
 * deploying. `ci doctor` would report that as `linked`: the exact silent
 * false-green this command exists to prevent. When Vercel needs a decision it
 * refuses with a structured reason instead, and that is relayed.
 *
 * `vercel git connect` is effectively idempotent — an already-connected repo
 * says so, which also resolves the one ambiguity `ci doctor` cannot see from
 * GitHub: "never linked" vs "linked but never deployed".
 */
export async function runCiConnect(opts: CiConnectOptions, deps: CiDeps = {}): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = new Output(opts.output, { stdout, stderr });
  const cwd = deps.cwd ?? process.cwd();
  const spawn = deps.spawn ?? defaultSpawn;
  const fs = deps.fs ?? defaultCiFs;
  const platform = deps.platform ?? process.platform;
  const ran: string[] = [];

  // Input gate before any subprocess or fs read: a bad name must fail as a
  // validation error, not as a spawned command's stderr.
  if (opts.project !== undefined && !VERCEL_PROJECT_NAME_RE.test(opts.project)) {
    throw localValidationError(
      'project',
      'must be a Vercel project name (lowercase letters, digits, ".", "_", "-"; max 100 chars)',
    );
  }

  const finish = (over: Partial<CiConnectSummary>, failure?: string): void => {
    const summary: CiConnectSummary = {
      platform: 'vercel',
      ran,
      connected: false,
      alreadyConnected: false,
      reason: null,
      ...over,
    };
    out.print(summary, d => renderCiConnectText(d as CiConnectSummary));
    if (failure !== undefined) throw new CLIError(failure, 1);
  };

  const run = (args: string[]): SpawnSyncReturns<string> | { failure: string } => {
    ran.push(`npx ${VERCEL_CLI_SPEC} ${args.join(' ')}`);
    try {
      // npx's own `--yes` only suppresses its install prompt; nothing after the
      // package spec is a `--yes` (see the function comment). On Windows `npx`
      // is a `.cmd` shim, which `spawnSync` cannot launch with `shell: false`
      // (EINVAL since Node 20.12's CVE-2024-27980 hardening, ENOENT before) —
      // go through the shell there. Safe because every argument is a literal or
      // validated against VERCEL_PROJECT_NAME_RE, never free text.
      return platform === 'win32'
        ? spawn('npx.cmd', ['--yes', VERCEL_CLI_SPEC, ...args], { cwd, shell: true })
        : spawn('npx', ['--yes', VERCEL_CLI_SPEC, ...args], { cwd });
    } catch (err) {
      return { failure: `failed to run npx: ${(err as Error).message}` };
    }
  };

  // `.vercel/project.json` is how the Vercel CLI itself records which project
  // this directory is linked to. Present → the project is already decided and
  // `git connect` is safe to run directly.
  let dirLinked = false;
  try {
    await fs.readFile(path.join(cwd, '.vercel', 'project.json'));
    dirLinked = true;
  } catch {
    /* not linked */
  }

  if (!dirLinked) {
    if (opts.project === undefined || opts.project === '') {
      // Refuse rather than guess: picking (or worse, creating) a project is
      // the one decision this command must never make for the user.
      finish(
        { reason: 'this directory is not linked to a Vercel project' },
        'ci connect: this directory is not linked to a Vercel project — pass --project <name>, or run `npx vercel link` to pick one interactively, then re-run',
      );
      return;
    }
    // `link --project <name>` targets an EXISTING project by name, so it needs
    // no `--yes` and cannot create one as a side effect.
    const link = run(['link', '--project', opts.project, '--non-interactive']);
    if ('failure' in link) {
      finish({ reason: link.failure }, `ci connect: ${link.failure}`);
      return;
    }
    if (link.status !== 0) {
      const detail = vercelFailureDetail(link);
      finish(
        { reason: `vercel link failed${detail ? `: ${detail}` : ''}` },
        `ci connect: could not link this directory to Vercel project "${opts.project}"${detail ? ` — ${detail}` : ''}`,
      );
      return;
    }
  }

  const connect = run(['git', 'connect', '--non-interactive']);
  if ('failure' in connect) {
    finish({ reason: connect.failure }, `ci connect: ${connect.failure}`);
    return;
  }
  // "already connected" is prose on exit 1 with no JSON — Vercel offers no
  // structured way to see it (`project inspect` does not expose git-link
  // state), so a regex on the CLI's wording is load-bearing here. If Vercel
  // rephrases it, this degrades to the generic relay below (a hard failure
  // with Vercel's own message), never to a wrong success.
  const output = `${connect.stdout ?? ''}\n${connect.stderr ?? ''}`;
  const alreadyConnected = /already connected/i.test(output);
  if (connect.status !== 0 && !alreadyConnected) {
    const detail = vercelFailureDetail(connect);
    // The common dead ends — not logged in (browser OAuth), the Vercel GitHub
    // App not installed, missing org permission — all need a human. Relay the
    // CLI's own message verbatim rather than paraphrasing the fix away.
    finish(
      { reason: detail || `vercel git connect exited ${connect.status}` },
      `ci connect: ${detail || 'could not connect the repo'}`,
    );
    return;
  }

  finish({ connected: true, alreadyConnected });
  stderr(
    alreadyConnected
      ? '[info] the repo was already connected — if `ci doctor` still reports no events, it simply has not deployed yet.'
      : '[info] connected. Linking only affects FUTURE pushes.',
  );
  stderr('Next: push a commit on a branch so a preview deployment lands:');
  stderr('  git checkout -b verify-testsprite-ci');
  stderr('  git commit --allow-empty -m "verify testsprite ci" && git push -u origin HEAD');
  stderr('Then: testsprite ci doctor --wait');
}

export function renderCiConnectText(s: CiConnectSummary): string {
  if (s.connected) {
    return s.alreadyConnected
      ? 'Vercel is already connected to this repo.'
      : 'Connected Vercel to this repo.';
  }
  const lines = [`Could not connect automatically: ${s.reason ?? 'unknown reason'}.`, ''];
  lines.push('Do it manually:');
  lines.push('  npx vercel login        # if you are not signed in');
  lines.push('  npx vercel link         # pick the Vercel project for this directory');
  lines.push('  npx vercel git connect  # link it to the git remote');
  lines.push('');
  lines.push('…then re-run `testsprite ci connect`, or finish from the Vercel dashboard');
  lines.push('(Project → Settings → Git).');
  return lines.join('\n');
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
  lines.push(`${verb} (project ${s.projectId}, environment ${s.environment}).`);
  if (s.backupPath)
    lines.push(`The previous file was kept as ${s.backupPath}; re-apply your edits.`);
  lines.push('');
  lines.push('Next steps:');
  lines.push(`  1. Replace the "REPLACE ME" step in ${s.path} with where this PR's preview URL`);
  lines.push('     comes from (the comment on it shows both options). Until then the check fails.');
  if (s.secret.set) {
    lines.push(`  2. ✓ ${s.secret.name} repo secret set via gh.`);
  } else {
    lines.push(`  2. Add the ${s.secret.name} repo secret (the workflow reads the key from it):`);
    lines.push(`       gh secret set ${s.secret.name}          # paste your key when prompted`);
    lines.push('     …or in the GitHub UI: Settings → Secrets and variables → Actions.');
  }
  lines.push(`  3. Commit and push ${s.path}, then open a PR and confirm the check runs`);
  lines.push("     against that PR's preview. To block merges on it, make it a required check.");
  return lines.join('\n');
}

// ── command builder ──────────────────────────────────────────────────────────

export type CiRunOptions = Omit<
  RunTestRunAllOptions,
  'wait' | 'ci' | 'admission' | 'previewName' | 'githubTrigger'
> & {
  failOnSkipped?: boolean;
  /** `--execution-report-timeout`: how long to wait for the execution report (default 60). */
  executionReportTimeoutSeconds?: number;
  /** `--no-execution-report`: job summary stays the local table; nothing is read or written for the report. */
  executionReport?: boolean;
};

/**
 * `ci run` = `test run --all --wait` with CI's defaults, plus what only a CI
 * job can add:
 *
 *  - `admission: 'all'` — one request, one execution, server-side pacing (as
 *    for a GitHub App run), so a PR run is one row in the Portal and, in a
 *    pull request, one `github-pr-<N>` environment. The backend echoes the
 *    field; a backend that cannot honour it is refused (exit 7), never
 *    silently cut to the per-key budget and retried.
 *  - In a pull request (read off the Actions event, or looked up from the
 *    deployment's commit), `--env X --target-url U` runs in a temporary clone
 *    of X at U named `github-pr-<N>`, and the run is stamped with the PR so
 *    the Portal links back to it — the GitHub App's own mechanism.
 *  - Outside a pull request the run keeps `test run`'s semantics: X's sign-in
 *    against U, recorded under X.
 */
export async function runCiRun(opts: CiRunOptions, deps: TestDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout;
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (opts.targetUrl !== undefined && opts.targetUrl.trim() === '') {
    throw localValidationError('target-url', 'must be a non-empty URL');
  }
  // An unknown environment name is a configuration error, not an empty
  // selection: refused here, before anything dispatches or charges, so it
  // can never read as a green `--allow-empty` run.
  try {
    await assertCiEnvironmentExists(opts, deps);
  } catch (err) {
    // The CLI's own "no such environment" refusal is `refused_env`; any API
    // refusal while listing (401, 402, 429, …) takes the shared mapping.
    if (err instanceof ApiError && err.code === 'VALIDATION_ERROR' && err.details.field === 'env') {
      recordTelemetryExtras({ ciRunOutcome: 'refused_env' });
    } else if (err instanceof ApiError) {
      recordTelemetryExtras({ ciRunOutcome: ciRefusalOutcome(err) });
    }
    throw err;
  }

  const github = await readGithubRunContext(env, { fetchImpl: deps.fetchImpl });
  let previewName: string | undefined;
  let githubTrigger: CiGithubTrigger | undefined;
  if (github.kind === 'pull_request') {
    if (github.draft) {
      recordTelemetryExtras({ ciRunOutcome: 'skipped_draft' });
      skipCiRun(
        `Skipping draft pull request #${github.trigger.prNumber}; the gate runs once it is ready for review.`,
        opts.output,
        { env, stdout, stderr },
      );
      return;
    }
    githubTrigger = github.trigger;
    // The clone needs a template to clone and an address to point at.
    if (opts.targetUrl !== undefined && opts.environment !== undefined) {
      previewName = previewEnvironmentName(github.trigger.prNumber);
    }
  } else if (github.kind === 'no_pull_request' && github.event === 'deployment_status') {
    // A deployment that belongs to no pull request has nothing to gate.
    recordTelemetryExtras({ ciRunOutcome: 'skipped_no_pr' });
    skipCiRun(`Skipping: ${github.reason}; nothing to gate.`, opts.output, {
      env,
      stdout,
      stderr,
    });
    return;
  }

  await runTestRunAll(
    {
      ...opts,
      timeoutSeconds: parseTimeoutSeconds(opts.timeoutSeconds),
      wait: true,
      ci: {
        failOnSkipped: opts.failOnSkipped,
        executionReportTimeoutSeconds: opts.executionReportTimeoutSeconds,
        ...(opts.executionReport === false ? { executionReport: false } : {}),
      },
      admission: 'all',
      ...(previewName !== undefined ? { previewName } : {}),
      ...(githubTrigger !== undefined ? { githubTrigger } : {}),
    },
    deps,
  );
}

/**
 * A `ci run` that has nothing to gate (a draft PR, a deployment with no pull
 * request) exits 0 with a `::notice::` — and still writes its step outputs, as
 * zeros, so a later step reading `steps.<id>.outputs.passed` sees a number
 * rather than an empty string. Under `--output json` stdout carries the
 * result too, `{skipped: true, reason, summary}`, so a script parsing it never
 * reads an empty string either. Nothing was dispatched, so nothing else (job
 * summary, summary file, report) is written: those describe runs.
 */
function skipCiRun(
  notice: string,
  output: OutputMode,
  io: { env: NodeJS.ProcessEnv; stdout?: (line: string) => void; stderr: (line: string) => void },
): void {
  io.stderr(`::notice title=TestSprite::${notice}`);
  const nothing: CiSummary = { total: 0, passed: 0, failed: 0, skipped: 0, timedOut: 0, runs: [] };
  if (output === 'json') {
    new Output(output, io).print({ skipped: true, reason: notice, summary: nothing });
  }
  emitCiStepOutputs(nothing, io);
}

/**
 * Strict `--env`: the name must be one of the project's environments, read
 * off the same list `test run` reads before a batch. Fails closed: a list that
 * cannot be read is an error with that error's own exit code (bad key → 3,
 * backend down → 10, interrupted → the signal's code) — never a run that goes
 * on to dispatch and charge against an environment nobody checked. The one
 * read that is NOT an error is a backend answering that this project has no
 * environment surface at all (a V2 project's `UNSUPPORTED`, or an older
 * backend's 404 for the route): there is no list to check against, and the
 * batch's own `environment` validation is the only authority left. Nothing to
 * check without a name, and a dry run makes no request.
 */
async function assertCiEnvironmentExists(opts: CiRunOptions, deps: TestDeps): Promise<void> {
  const environment = opts.environment?.trim();
  const projectId = opts.projectId ?? (deps.env ?? process.env).TESTSPRITE_PROJECT_ID;
  if (!environment || !projectId || opts.dryRun) return;
  let listed: { environments?: Array<{ name?: unknown }> };
  try {
    listed = await makeHttpClient(opts, {
      env: deps.env,
      credentialsPath: deps.credentialsPath,
      fetchImpl: deps.fetchImpl,
      stderr: deps.stderr,
    }).get<{ environments?: Array<{ name?: unknown }> }>(
      `/projects/${encodeURIComponent(projectId)}/env`,
    );
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'UNSUPPORTED' || err.httpStatus === 404)) {
      return;
    }
    throw err;
  }
  const names = (listed.environments ?? [])
    .map(e => e.name)
    .filter((n): n is string => typeof n === 'string');
  if (names.includes(environment)) return;
  throw localValidationError(
    'env',
    `no environment named "${environment}" in project ${projectId} — available: ${names.join(', ') || '(none)'}`,
  );
}

export function createCiCommand(deps: CiDeps = {}): Command {
  const ci = new Command('ci').description('Run tests in CI and scaffold CI integration');

  ci.command('run')
    .description('Run project tests, wait for results, and apply the CI gate')
    .allowExcessArguments(false)
    .option('--project <id>', 'project id (defaults to TESTSPRITE_PROJECT_ID)')
    .option('--all', 'run all project tests (already the default)')
    .option('--filter <substr>', 'only run tests whose name contains this substring')
    .option(
      '--env <name>',
      'the environment whose sign-in the run uses (unknown names fail). In a pull request, with --target-url, the run happens in a temporary clone of it at the preview address, named github-pr-<N> like a GitHub App run',
    )
    .option(
      '--target-url <url>',
      "frontend tests: the address to test, typically this pull request's preview deployment",
    )
    .option('--skip-preflight', 'skip the pre-charge reachability probe for --target-url', false)
    .option('--timeout <s>', 'max seconds to wait for results (1-3600)', '600')
    .option(
      '--execution-report-timeout <s>',
      'max seconds to wait for the execution report that fills the job summary (1-3600)',
      '60',
    )
    .option(
      '--no-execution-report',
      'keep the job summary to the local results table; read and write no execution report',
    )
    .option('--max-concurrency <n>', 'maximum concurrent polls (1-100)', '50')
    .option('--idempotency-key <key>', 'idempotency key for the batch dispatch')
    .option('--fail-on-skipped', 'fail if any requested test was not run (default: warn)')
    .option('--allow-empty', 'allow zero dispatched tests (default: exit 5)')
    .option('--gh-output', 'force GitHub annotations and job summary outside Actions')
    .option('--summary-file <path>', 'write the unified CI summary JSON to this file')
    .option('--report <format>', 'also write a report (junit); disabled by default')
    .option('--report-file <path>', 'JUnit report destination (requires --report junit)')
    .option('--report-suite-name <name>', 'JUnit suite name (default: testsprite:<projectId>)')
    .addHelpText(
      'after',
      '\nAlways waits for results. Failed tests and timeouts fail the gate.\n' +
        'Skipped tests warn unless --fail-on-skipped; missing test ids and unknown\n' +
        'environments always fail. Every selected test is seeded into ONE execution\n' +
        'and the server paces dispatch, as for a GitHub App run.\n' +
        'In GitHub Actions the pull request is read from the event (a deployment_status\n' +
        'event is looked up by commit with GITHUB_TOKEN); draft PRs and deployments\n' +
        'with no pull request are skipped with a notice and zero step outputs. The run\n' +
        'is stamped with the PR, so the Portal links back to it. ci run does not read\n' +
        "the deployment's state or environment: filter deployment_status events with\n" +
        "the job's `if:` (state == 'success', not production), or a failed or\n" +
        'production deployment is gated too.\n' +
        'Writes total, passed, failed, skipped, timedOut to GITHUB_OUTPUT when present.\n' +
        'On a supporting backend the job summary is the execution report — the same content\n' +
        'the GitHub App posts as its PR comment — and execution-report-file /\n' +
        'execution-report-markdown-file name its JSON and Markdown for later steps.\n' +
        'Reports and outputs are emitted before the exit code is decided.\n' +
        'Backend tests use the URL in their own code, not --target-url. PR comments are not yet supported.\n',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts, command: Command) => {
      await runCiRun(
        {
          ...resolveCommonOptions(command),
          projectId: cmdOpts.project,
          nameFilter: cmdOpts.filter,
          environment: cmdOpts.env,
          targetUrl: cmdOpts.targetUrl,
          skipPreflight: cmdOpts.skipPreflight === true,
          timeoutSeconds: parseTimeoutSeconds(cmdOpts.timeout),
          executionReportTimeoutSeconds: parseExecutionReportTimeoutSeconds(
            cmdOpts.executionReportTimeout,
          ),
          // Commander's `--no-execution-report` sets `executionReport: false`
          // (true when absent).
          executionReport: cmdOpts.executionReport !== false,
          maxConcurrency: Number(cmdOpts.maxConcurrency),
          idempotencyKey: cmdOpts.idempotencyKey,
          failOnSkipped: cmdOpts.failOnSkipped === true,
          allowEmpty: cmdOpts.allowEmpty === true,
          ghOutput: cmdOpts.ghOutput === true,
          summaryFile: cmdOpts.summaryFile,
          report: parseJUnitReportFormat(cmdOpts.report),
          reportFile: cmdOpts.reportFile,
          reportSuiteName: cmdOpts.reportSuiteName,
        },
        deps,
      );
    });

  ci.command('init <platform>')
    .description('Write a CI workflow that runs your TestSprite tests (platform: github)')
    .option('--project <id>', 'project id to run (auto-detected if you have exactly one)')
    .option(
      '--env <name>',
      "environment whose sign-in each PR run uses (default: the project's default environment, written out by name)",
    )
    .option(
      '--timeout <s>',
      "max seconds ci run waits for a terminal verdict (1-3600; omitted: ci run's default)",
    )
    .option(
      '--path <file>',
      `workflow file to write, under ${WORKFLOWS_DIR}/ (.yml or .yaml)`,
      DEFAULT_WORKFLOW_PATH,
    )
    .option(
      '--force',
      'overwrite an existing workflow with different content (keeps a .bak)',
      false,
    )
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
      const common = resolveCommonOptions(command, deps.env);
      const opts: CiInitOptions = {
        ...common,
        platform,
        project: cmdOpts.project,
        env: cmdOpts.env,
        timeoutSeconds:
          cmdOpts.timeout === undefined ? undefined : parseTimeoutSeconds(cmdOpts.timeout),
        workflowPath: cmdOpts.path ?? DEFAULT_WORKFLOW_PATH,
        force: cmdOpts.force ?? false,
        setSecret: cmdOpts.setSecret ?? false,
        repo: cmdOpts.repo,
      };
      await runCiInit(opts, deps);
    });

  // `ci doctor` and `ci connect` are hidden and deprecated (step 1 of 2).
  // Platform checks and linking belong to the agent skill (`testsprite-ci`),
  // which reads the same deployment history and runs the platform's own CLI.
  // Behaviour and exit codes are unchanged until the commands are removed.
  ci.command('doctor', { hidden: true })
    .description(
      'Check that deployment events reach this repo — the precondition a deployment-gated workflow rests on',
    )
    .option('--repo <owner/name>', 'repo to check (inferred from the `origin` remote if omitted)')
    .option(
      '--wait',
      'keep checking until a NEW deployment record arrives (use right after connecting + pushing)',
      false,
    )
    .option('--timeout <s>', 'with --wait, how long to keep checking (1-3600, default 600)')
    .addHelpText(
      'after',
      '\nWhy this exists:\n' +
        '  A workflow triggered by deployments only fires if the repo actually receives\n' +
        "  GitHub Deployment events. When the deploy platform isn't linked to the repo,\n" +
        '  nothing is ever written and the gate stays silent — with no error anywhere.\n' +
        '\n--wait succeeds when any new deployment record arrives, whatever its\n' +
        'environment — a new record is the hard fact that events reach this repo.\n' +
        '\nExit codes:\n' +
        '  0  events reach this repo (a gate will fire), or --wait saw a new record\n' +
        '  1  no usable events yet — see the printed next steps\n' +
        '  5  validation error (bad --repo, or no GitHub remote here)\n' +
        ' 10  could not read the history (gh missing / unauthenticated) — not a verdict',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts, command: Command) => {
      emitCiDeprecationNotice('doctor', deps);
      const common = resolveCommonOptions(command, deps.env);
      await runCiDoctor(
        {
          ...common,
          repo: cmdOpts.repo,
          wait: cmdOpts.wait === true,
          // undefined = flag not given; runCiDoctor refuses it without --wait.
          waitTimeoutSeconds:
            cmdOpts.timeout === undefined ? undefined : parseTimeoutSeconds(cmdOpts.timeout),
        },
        deps,
      );
    });

  ci.command('connect', { hidden: true })
    .description('Link your deploy platform (Vercel) to this repo so deployment events are emitted')
    .option(
      '--project <name>',
      'Vercel project to link when this directory is not linked yet (must already exist)',
    )
    .addHelpText(
      'after',
      "\nRuns the platform's own CLI (`npx vercel link` / `vercel git connect`) as a\n" +
        'subprocess, always non-interactively: when a decision is needed (which project\n' +
        'to link) it refuses and says so rather than creating anything you did not pick.\n' +
        'Your Vercel credentials stay with the Vercel CLI — this command never asks for,\n' +
        'stores, or transmits a platform token.\n' +
        '\nNote: `vercel link` itself writes `.vercel/`, may add a VERCEL_OIDC_TOKEN line\n' +
        'to `.env.local`, and may update `.gitignore` — the Vercel CLI’s own behavior.\n' +
        '\nLinking only affects FUTURE pushes: push a commit afterwards, then confirm with\n' +
        '`testsprite ci doctor --wait`.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts, command: Command) => {
      emitCiDeprecationNotice('connect', deps);
      const common = resolveCommonOptions(command, deps.env);
      await runCiConnect({ ...common, project: cmdOpts.project }, deps);
    });

  return ci;
}

/**
 * One stderr line per run of a deprecated `ci` subcommand, naming the
 * equivalent commands (stdout stays clean for JSON pipelines). The
 * replacements are not `testsprite` commands, so this does not reuse
 * `emitDeprecationNotice`.
 */
export const CI_DEPRECATION_NOTICES = {
  doctor:
    '[deprecated] `testsprite ci doctor` will be removed in a later release. Read the deployment history yourself: ' +
    '`gh api repos/<owner>/<repo>/deployments` — judge preview and production records separately; a real pull request is the proof.',
  connect:
    "[deprecated] `testsprite ci connect` will be removed in a later release. Run the platform's own CLI: " +
    '`npx vercel link --project <name> --non-interactive`, then `npx vercel git connect --non-interactive` (or link the repo in the Vercel dashboard).',
} as const;

function emitCiDeprecationNotice(cmd: keyof typeof CI_DEPRECATION_NOTICES, deps: CiDeps): void {
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  stderr(CI_DEPRECATION_NOTICES[cmd]);
}
