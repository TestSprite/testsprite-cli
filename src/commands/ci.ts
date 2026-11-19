import { appendFileSync, promises as nodeFs } from 'node:fs';
import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as path from 'node:path';
import { Command } from 'commander';
import { equalIgnoringCrlf } from '../lib/text-equality.js';
import {
  makeHttpClient,
  parseRequestTimeoutFlag,
  resolveRequestTimeoutMs,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { ApiError, CLIError, localValidationError } from '../lib/errors.js';
import { loadConfig, resolveProfileName } from '../lib/config.js';
import { type FetchImpl, type HttpClient } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode } from '../lib/output.js';
import type { Page } from '../lib/pagination.js';
import { inspectTargetPath, type TargetPathFs } from '../lib/target-path.js';
import { assertNotLocal } from '../lib/target-url.js';
import { ciRefusalOutcome, recordTelemetryExtras } from '../lib/telemetry.js';
import type { CliProject } from './project.js';
import {
  parseNameFilter,
  runTestRunAll,
  type RunTestRunAllOptions,
  type TestDeps,
} from './test.js';
import { emitCiStepOutputs, escapeCommandData, type CiSummary } from '../lib/gh-output.js';
import {
  previewEnvironmentName,
  readGithubRunContext,
  type GithubRunContext,
} from '../lib/github-context.js';
import { waitForCommitSignal } from '../lib/commit-signal.js';
import {
  missingPlaceholders,
  renderUrlTemplate,
  type UrlTemplateVars,
  unsafeHostPlaceholders,
  validateUrlTemplate,
} from '../lib/url-template.js';
import { globalShutdown } from '../lib/interrupt.js';
import type { CiGithubTrigger } from '../lib/runs.types.js';
import { parseJUnitReportFormat } from '../lib/junit-report.js';
import type { CliProjectEnvListResponse } from './project-env.js';
import { terminalSafeWriter } from '../lib/terminal-text.js';

// ── constants ────────────────────────────────────────────────────────────────

/** Platforms `ci init` can scaffold. One today; the positional arg leaves room. */
const SUPPORTED_PLATFORMS = ['github'] as const;
type Platform = (typeof SUPPORTED_PLATFORMS)[number];

/** Default location a GitHub Actions workflow must live to be picked up. */
const DEFAULT_WORKFLOW_PATH = '.github/workflows/testsprite.yml';

/** Where GitHub Actions picks workflows up from; `--path` must stay inside it. */
const WORKFLOWS_DIR = '.github/workflows';

/** Default terminal-verdict wait, matching the CLI's own `run` default. */
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
 * refuse clobbering, recursive mkdir to create parent dirs). Path inspection
 * shares the agent installer's component walk.
 */
export interface CiFs extends TargetPathFs {
  realpath(target: string): Promise<string>;
  writeFile(target: string, data: string, opts?: { exclusive?: boolean }): Promise<void>;
  mkdir(dir: string): Promise<void>;
  readFile(target: string): Promise<string>;
  /** Entry names in `dir`; rejects with ENOENT when the directory is absent. */
  readdir(dir: string): Promise<string[]>;
}

const defaultCiFs: CiFs = {
  async lstat(target) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inspect each component before writing the caller-selected workflow path.
      const stat = await nodeFs.lstat(target);
      return { isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolve the repository and workflow symlink for containment validation.
  realpath: target => nodeFs.realpath(target),
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
 * shell out. Runs `gh` (optional secret set). */
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
  /** Injected by tests so polling never really sleeps. */
  sleep?: (ms: number) => Promise<void>;
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
  // All generated workflows live directly under .github/workflows/. Keep the
  // readable filename, including its extension; escape rather than discard
  // punctuation so distinct filenames cannot collapse to the same slug.
  // GitHub compares concurrency group names case-insensitively, so uppercase
  // letters are escaped too (keeping existing %XX escapes intact): otherwise
  // TestSprite.yml and testsprite.yml would share a group.
  const workflowSlug = encodeURIComponent(path.posix.basename(input.workflowPath)).replace(
    /%[0-9A-F]{2}|[A-Z]/g,
    match => (match.startsWith('%') ? match : `%${match.charCodeAt(0).toString(16).toUpperCase()}`),
  );

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
    # Include this workflow's filename: concurrency groups are repository-wide,
    # so another project's workflow must not cancel this gate.
    # B (pull_request): a new push to the pull request cancels the previous job.
    # A (deployment_status): one group per COMMIT — Vercel sets deployment.ref to
    # the commit sha, so a new push does not cancel the previous commit's job.
    # Job-level, so events the if: below drops (pending, inactive, another
    # project's deployment of the same commit) never cancel a running gate.
    # Cancelling only stops this job's CLI: the TestSprite run it started keeps
    # executing and reports in the Portal; the new push starts its own run.
    concurrency:
      group: testsprite-${workflowSlug}-\${{ github.event.pull_request.number || github.event.deployment.sha }}
      cancel-in-progress: true
    # pull_request: skip fork PRs (they get no repository secrets), Dependabot PRs
    # (Dependabot secrets are not Actions secrets), and draft PRs.
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
       github.actor != 'dependabot[bot]' &&
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
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: '22'
          # Only the CLI is installed below. Without this, an npm repo
          # (package.json "packageManager": "npm@…") with no lockfile fails here.
          package-manager-cache: false

      - run: npm i -g ${CLI_PACKAGE_SPEC}

      # REPLACE ME — where does this PR's preview URL come from? Pick one:
      # A. Your platform deploys every PR: delete this step (and switch the trigger
      #    above). The next step then reads the URL from the deployment event.
      # B. You deploy in this workflow: replace the run lines with your deploy
      #    commands and end with:  echo "url=<preview address>" >> "$GITHUB_OUTPUT"
      # C. Your platform only posts a commit status or check on the PR (no deployment
      #    event): delete this step, keep the pull_request trigger, and in the step below
      #    replace the PREVIEW_URL env and the --target-url "$PREVIEW_URL" line with
      #      --wait-for-status "<its name on the PR>" --target-url-template "<pattern>"
      #    (placeholders {pr} {branch-slug} {sha} …, e.g. https://app-git-{branch-slug}-team.vercel.app),
      #    then add  statuses: read  and  checks: read  under permissions: above.
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
        uses: actions/upload-artifact@v7
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
  const stderr = terminalSafeWriter(deps.stderr);
  const fs = deps.fs ?? defaultCiFs;
  const cwd = deps.cwd ?? process.cwd();
  const out = new Output(opts.output, { stdout, stderr });

  // Validate the caller's own inputs up front — BEFORE any round trip — so a
  // bad --project/--env/--path fails fast without a wasted request.
  if (opts.project) assertSafeWorkflowValue('project', opts.project);
  if (opts.env) assertSafeWorkflowValue('env', opts.env);
  const { relPath, absPath } = resolveWorkflowPath(opts.workflowPath, cwd);
  const allowInternalSymlink = async (target: string): Promise<void> => {
    let resolved: string;
    let root: string;
    try {
      [root, resolved] = await Promise.all([fs.realpath(cwd), fs.realpath(target)]);
    } catch {
      throw new CLIError(
        `cannot resolve symlink at "${target}"; refusing to write the workflow.`,
        5,
      );
    }
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new CLIError(
        `refusing to write through symlink "${target}": "${resolved}" is outside the repository.`,
        5,
      );
    }
  };
  await inspectTargetPath(fs, cwd, relPath, allowInternalSymlink);
  if (opts.force) {
    await inspectTargetPath(fs, cwd, `${relPath}.bak`, allowInternalSymlink);
  }

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
    if (equalIgnoringCrlf(prior, workflow)) {
      // Equivalent apart from CRLF conversion: no rewrite, and re-running (with or
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
  /**
   * `--target-url-template`: the preview address as a pattern (`{pr}`,
   * `{branch-slug}`, `{sha}`, …), filled on the runner from the pull request's
   * facts; mutually exclusive with `--target-url`.
   */
  targetUrlTemplate?: string;
  /** `--wait-for-status`: the commit status context / check-run name that says the preview exists. */
  waitForStatus?: string;
  /** `--status-timeout`: how long `--wait-for-status` waits (seconds; default 900). */
  statusTimeoutSeconds?: number;
};

/** How long `--wait-for-status` waits by default — a preview build is minutes, so its own budget, not `--timeout`'s. */
export const DEFAULT_STATUS_TIMEOUT_SECONDS = 900;

export function parseStatusTimeoutSeconds(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 3600) {
    throw localValidationError('status-timeout', 'must be an integer between 1 and 3600 seconds');
  }
  return n;
}

/**
 * `ci run` = `run --project --wait` with CI's defaults, plus what only a CI
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
 *  - Outside a pull request the run keeps `run`'s semantics: X's sign-in
 *    against U, recorded under X.
 */
export async function runCiRun(opts: CiRunOptions, deps: TestDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const stderr = terminalSafeWriter(deps.stderr);
  if (opts.targetUrl !== undefined && opts.targetUrl.trim() === '') {
    throw localValidationError('target-url', 'must be a non-empty URL');
  }
  // The template and the wait are checked for shape before any request: a
  // bad pattern or a dangling --status-timeout is a configuration error, and
  // must not first show up after minutes of waiting.
  if (opts.targetUrlTemplate !== undefined) {
    if (opts.targetUrl !== undefined) {
      throw localValidationError(
        'target-url-template',
        'cannot be combined with --target-url; pass the address or the pattern, not both',
      );
    }
    if (opts.targetUrlTemplate.trim() === '') {
      throw localValidationError('target-url-template', 'must be a non-empty URL pattern');
    }
    const problem = validateUrlTemplate(opts.targetUrlTemplate.trim());
    if (problem !== null) throw localValidationError('target-url-template', problem);
  }
  if (opts.waitForStatus !== undefined && opts.waitForStatus.trim() === '') {
    throw localValidationError(
      'wait-for-status',
      'must name the commit status context or check run to wait for (as shown on the pull request)',
    );
  }
  if (opts.statusTimeoutSeconds !== undefined && opts.waitForStatus === undefined) {
    throw localValidationError('status-timeout', 'only applies with --wait-for-status');
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

  const github = await readGithubRunContext(env, {
    fetchImpl: deps.fetchImpl,
    requestTimeoutMs: resolveRequestTimeoutMs(opts, env),
  });
  let previewName: string | undefined;
  let githubTrigger: CiGithubTrigger | undefined;
  if (github.kind === 'pull_request') {
    if (github.draft) {
      recordTelemetryExtras({ ciRunOutcome: 'skipped_draft' });
      skipCiRun(
        `Skipping draft pull request #${github.trigger.prNumber}; the gate runs once it is ready for review.`,
        { env, stderr },
      );
      return;
    }
    githubTrigger = github.trigger;
    // The clone needs a template to clone and an address to point at.
    if (
      (opts.targetUrl !== undefined || opts.targetUrlTemplate !== undefined) &&
      opts.environment !== undefined
    ) {
      previewName = previewEnvironmentName(github.trigger.prNumber);
    }
  } else if (github.kind === 'no_pull_request' && github.event === 'deployment_status') {
    // A deployment that belongs to no pull request has nothing to gate.
    recordTelemetryExtras({ ciRunOutcome: 'skipped_no_pr' });
    skipCiRun(`Skipping: ${github.reason}; nothing to gate.`, { env, stderr });
    return;
  }

  const facts = commitFacts(github, env);
  // Shape C: the platform wrote no deployment event, only a status or check on
  // the head commit. Wait for it before anything is rendered or dispatched.
  if (opts.waitForStatus !== undefined && !opts.dryRun) {
    const ready = await awaitPreviewSignal(opts, facts, { env, stderr }, deps);
    if (!ready) return;
  }
  const { targetUrlTemplate, waitForStatus, statusTimeoutSeconds, ...batchOpts } = opts;
  void waitForStatus;
  void statusTimeoutSeconds;
  let targetUrl = opts.targetUrl;
  if (targetUrlTemplate !== undefined) {
    const template = targetUrlTemplate.trim();
    const rendered = renderUrlTemplate(template, facts);
    if (rendered === null) {
      // Never a guess: a pattern this run cannot fill is refused, and the
      // reason names the placeholders so the fix is the pattern or the trigger.
      recordTelemetryExtras({ ciRunOutcome: 'refused_url_template' });
      const unsafe = unsafeHostPlaceholders(template, facts);
      if (unsafe.length > 0) {
        // The value would change the host (`{branch}` = "attacker.example/x" in
        // `https://{branch}.preview…`): never dispatched, the environment's
        // sign-in stays where it belongs.
        throw ApiError.fromEnvelope({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request.',
            nextAction: `Flag \`--target-url-template\` refused: ${unsafe.join(', ')} would change the host of the rendered URL (only letters, digits and - are allowed there). Use {branch-slug} in the host part, or pass --target-url.`,
            requestId: 'local',
            details: {
              field: 'target-url-template',
              reason: 'url_unsafe_host',
              unsafe: unsafe.join(', '),
            },
          },
        });
      }
      const missing = missingPlaceholders(template, facts).join(', ');
      const where =
        github.kind === 'outside_actions'
          ? 'outside GitHub Actions'
          : github.kind === 'no_pull_request'
            ? `on a ${github.event || 'non-PR'} event`
            : 'for this pull request';
      throw ApiError.fromEnvelope({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request.',
          nextAction: `Flag \`--target-url-template\` could not be filled ${where}: ${missing} ${missing.includes(',') ? 'have' : 'has'} no value. Use a placeholder the trigger provides, or pass --target-url.`,
          requestId: 'local',
          details: { field: 'target-url-template', reason: 'url_unresolved', missing },
        },
      });
    }
    targetUrl = rendered;
    stderr(`[ci run] --target-url-template rendered to ${rendered}`);
  }

  await runTestRunAll(
    {
      ...batchOpts,
      ...(targetUrl !== undefined ? { targetUrl } : {}),
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
 * rather than an empty string. Nothing was dispatched, so nothing else (job
 * summary, summary file, report) is written: those describe runs.
 */
function skipCiRun(
  notice: string,
  io: { env: NodeJS.ProcessEnv; stderr: (line: string) => void },
  opts: {
    /**
     * A job-summary line for a skip the reader must not mistake for a green
     * run — `--wait-for-status` learning there is no preview is one: nothing
     * ran, and the summary says so instead of staying empty.
     */
    jobSummary?: string;
  } = {},
): void {
  // The notice can carry a third-party check's text: encoded as workflow-command
  // data, so a line break in it cannot start a second command.
  io.stderr(`::notice title=TestSprite::${escapeCommandData(notice)}`);
  const nothing: CiSummary = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    timedOut: 0,
    results: [],
  };
  emitCiStepOutputs(nothing, io);
  const summaryPath = io.env.GITHUB_STEP_SUMMARY;
  if (opts.jobSummary !== undefined && typeof summaryPath === 'string' && summaryPath.length > 0) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- GITHUB_STEP_SUMMARY is the runner-provided job-summary path; only the CLI's own Markdown line is appended.
      appendFileSync(summaryPath, `${opts.jobSummary}\n`, 'utf8');
    } catch {
      io.stderr('[ci run] could not append to GITHUB_STEP_SUMMARY; continuing');
    }
  }
}

/**
 * The facts a `--target-url-template` is filled from. In a pull request they
 * are the PR's; outside one (a push, a schedule) what the runner exposes —
 * `{pr}` then has no value and a pattern using it is refused.
 */
function commitFacts(github: GithubRunContext, env: NodeJS.ProcessEnv): UrlTemplateVars {
  if (github.kind === 'pull_request') {
    return {
      pr: github.trigger.prNumber,
      branch: github.trigger.branchName ?? null,
      sha: github.trigger.commitSha ?? null,
    };
  }
  return {
    pr: null,
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null,
    sha: env.GITHUB_SHA || null,
  };
}

/**
 * `--wait-for-status`: block until the named status / check run on the head
 * commit is terminal. `true` = the preview exists, carry on. `false` = there
 * is no preview (the deploy failed, or the build was skipped) — reported as a
 * skip, exit 0, nothing dispatched. Nothing terminal in time is exit 7,
 * listing every name seen on the commit so a misspelled name is obvious.
 */
async function awaitPreviewSignal(
  opts: CiRunOptions,
  facts: UrlTemplateVars,
  io: { env: NodeJS.ProcessEnv; stderr: (line: string) => void },
  deps: TestDeps,
): Promise<boolean> {
  const name = opts.waitForStatus!.trim();
  const token = io.env.GITHUB_TOKEN;
  if (!token) {
    throw localValidationError(
      'GITHUB_TOKEN',
      '--wait-for-status reads the checks on the commit with the job token — add `GITHUB_TOKEN: ${{ github.token }}` to the step env',
      undefined,
      'field',
    );
  }
  const [repoOwner, repoName, ...rest] = (io.env.GITHUB_REPOSITORY ?? '').split('/');
  if (!repoOwner || !repoName || rest.length > 0 || !facts.sha) {
    throw localValidationError(
      'wait-for-status',
      'needs a GitHub Actions job with a commit to watch (GITHUB_REPOSITORY and the pull request head sha, or GITHUB_SHA)',
    );
  }
  const timeoutMs = (opts.statusTimeoutSeconds ?? DEFAULT_STATUS_TIMEOUT_SECONDS) * 1000;
  io.stderr(
    `[ci run] waiting up to ${timeoutMs / 1000}s for "${name}" on ${facts.sha.slice(0, 7)} to finish`,
  );
  const verdict = await waitForCommitSignal(
    { repoOwner, repoName, sha: facts.sha, name },
    { token, timeoutMs },
    {
      env: io.env,
      fetchImpl: deps.fetchImpl ?? globalThis.fetch,
      sleep: deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
      shutdown: deps.shutdown ?? globalShutdown,
      stderr: io.stderr,
    },
  );
  if (verdict.kind === 'ready') {
    io.stderr(
      `[ci run] "${name}" succeeded (${verdict.signal.via === 'status' ? 'commit status' : 'check run'}); the preview is up`,
    );
    return true;
  }
  if (verdict.kind === 'skip') {
    recordTelemetryExtras({ ciRunOutcome: 'skipped_no_preview' });
    skipCiRun(`No preview for this commit — tests not run: ${verdict.reason}.`, io, {
      jobSummary: `> **TestSprite:** no preview for this commit — tests not run: ${verdict.reason}.`,
    });
    return false;
  }
  recordTelemetryExtras({ ciRunOutcome: 'timeout_preview' });
  const nothing: CiSummary = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    timedOut: 0,
    results: [],
  };
  emitCiStepOutputs(nothing, io);
  const seen = verdict.seen.length > 0 ? verdict.seen.map(s => `"${s}"`).join(', ') : 'none';
  throw ApiError.fromEnvelope({
    error: {
      code: 'UNSUPPORTED',
      message: `Waited ${Math.round(verdict.waitedMs / 1000)}s and no status or check named "${name}" reached a terminal state on ${facts.sha.slice(0, 7)}.`,
      nextAction: `Check the name against what the pull request shows (seen on this commit: ${seen}), or raise --status-timeout.`,
      requestId: 'local',
      details: { field: 'wait-for-status', reason: 'preview-status-timeout', seen: verdict.seen },
    },
  });
}

/**
 * Strict `--env`: the name must be one of the project's environments, read
 * off the same list `run` reads before a batch. Fails closed: a list that
 * cannot be read is an error with that error's own exit code (bad key → 3,
 * backend down → 10, interrupted → the signal's code) — never a run that goes
 * on to dispatch and charge against an environment nobody checked. The one
 * read that is NOT an error is an older backend's 404 for the route: there is
 * no list to check against, and the batch's own `environment` validation is
 * the only authority left. Nothing to
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
    if (err instanceof ApiError && err.httpStatus === 404) {
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

/** Build CI run and workflow scaffolding commands with injectable runtime dependencies. */
export function createCiCommand(deps: CiDeps = {}): Command {
  const ci = new Command('ci').description('Run tests in CI and scaffold CI integration');

  ci.command('run')
    .description('Run project tests, wait for results, and apply the CI gate')
    .allowExcessArguments(false)
    .option('--project <id>', 'project id (defaults to TESTSPRITE_PROJECT_ID)')
    .option('--all', 'run all project tests (already the default)')
    .option(
      '--filter <substr>',
      'only run tests whose name contains this non-empty substring (case-insensitive); omit to run every test',
    )
    .option(
      '--env <name>',
      'the environment whose sign-in the run uses (unknown names fail). In a pull request, with --target-url, the run happens in a temporary clone of it at the preview address, named github-pr-<N> like a GitHub App run',
    )
    .option(
      '--target-url <url>',
      "frontend tests: the address to test, typically this pull request's preview deployment",
    )
    .option(
      '--target-url-template <pattern>',
      'the preview address as a pattern filled from the pull request: {pr}, {branch}, {branch-slug}, {sha}, {short-sha} (e.g. https://app-git-{branch-slug}-team.vercel.app); instead of --target-url',
    )
    .option(
      '--wait-for-status <name>',
      'wait for this commit status context or check run on the head commit to succeed before running (the name as the pull request shows it, e.g. "Vercel"); a failed or skipped build exits 0 with a notice',
    )
    .option(
      '--status-timeout <s>',
      `max seconds --wait-for-status waits (1-3600; default ${DEFAULT_STATUS_TIMEOUT_SECONDS})`,
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
        'environments always fail. Every selected test is seeded into ONE run\n' +
        'and the server paces dispatch, as for a GitHub App run.\n' +
        'In GitHub Actions the pull request is read from the event (a deployment_status\n' +
        'event is looked up by commit with GITHUB_TOKEN); draft PRs and deployments\n' +
        'with no pull request are skipped with a notice and zero step outputs. The run\n' +
        'is stamped with the PR, so the Portal links back to it. ci run does not read\n' +
        "the deployment's state or environment: filter deployment_status events with\n" +
        "the job's `if:` (state == 'success', not production), or a failed or\n" +
        'production deployment is gated too.\n' +
        'Writes total, passed, failed (includes blocked), blocked, failedOnly, skipped and timedOut to GITHUB_OUTPUT.\n' +
        'On a supporting backend the job summary is the execution report — the same content\n' +
        'the GitHub App posts as its PR comment — and execution-report-file /\n' +
        'execution-report-markdown-file name its JSON and Markdown for later steps.\n' +
        'Reports and outputs are emitted before the exit code is decided.\n' +
        'When the platform posts only a commit status or check (no deployment event),\n' +
        '--wait-for-status <name> holds the run until it succeeds and --target-url-template\n' +
        'derives the preview address from the pull request; a pattern that cannot be filled\n' +
        'is refused, never guessed. In a pull request the run happens in a github-pr-<N> clone\n' +
        'of --env at --target-url, so backend tests whose code uses VAR_{url} follow the preview\n' +
        "too; outside one, with --env, they use that environment's own URL. PR comments are not\n" +
        'yet supported.\n',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts, command: Command) => {
      await runCiRun(
        {
          ...resolveCommonOptions(command),
          projectId: cmdOpts.project,
          nameFilter: parseNameFilter(cmdOpts.filter),
          environment: cmdOpts.env,
          targetUrl: cmdOpts.targetUrl,
          targetUrlTemplate: cmdOpts.targetUrlTemplate,
          waitForStatus: cmdOpts.waitForStatus,
          statusTimeoutSeconds:
            cmdOpts.statusTimeout === undefined
              ? undefined
              : parseStatusTimeoutSeconds(cmdOpts.statusTimeout),
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
    .summary('Write a CI workflow that runs your test cases on pull requests (github)')
    .description(
      "Write a CI workflow (platform: github) that runs the project's TestSprite test cases against each\n" +
        'pull request\'s preview deployment; each run spends credits. Replace the "REPLACE ME" step in the\n' +
        `generated file with your preview URL. Needs the ${API_KEY_SECRET_NAME} repo secret (see --set-secret).`,
    )
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

  return ci;
}
