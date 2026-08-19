/**
 * `testsprite doctor` — one-shot environment diagnostic.
 *
 * Runs a fixed checklist (CLI version, Node.js runtime, active profile, API
 * endpoint, credentials, live connectivity + key validity, and whether the
 * verify skill is installed in the current project) and prints an OK/WARN/FAIL
 * report. Exits non-zero when any check FAILS so it can gate a CI step or an
 * agent preflight (`testsprite doctor && testsprite test run ...`). Warnings
 * (e.g. skill not installed) do not fail the process.
 *
 * Every check is reused from the same helpers the real commands use, so the
 * report reflects exactly what a subsequent command would resolve: `loadConfig`
 * for profile/endpoint/key, `assertValidEndpointUrl` for the endpoint gate,
 * `makeHttpClient` + `GET /me` for connectivity, and `isVerifySkillInstalled`
 * for the skill check.
 */

import { Command } from 'commander';
import {
  assertValidEndpointUrl,
  makeHttpClient,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { loadConfig } from '../lib/config.js';
import { ApiError, CLIError, localValidationError } from '../lib/errors.js';
import type { FetchImpl } from '../lib/http.js';
import type { CliOrgBinding, CliOrgSummary } from '../lib/org-render.js';
import { formatOrgBinding, formatOrgsSummary, formatPersonalScopeHint } from '../lib/org-render.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import { isVerifySkillInstalled } from '../lib/skill-nudge.js';
import { emitV3RoutingAdvisory, routingLabel } from '../lib/v3-advisory.js';
import { VERSION } from '../version.js';
import { MIN_SUPPORTED_NODE_MAJOR, shouldRejectNodeVersion } from '../version-guard.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  /** Short, stable label (also the JSON key-ish name). */
  name: string;
  status: DoctorStatus;
  /** Human-readable one-line result. Never contains the API key. */
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  failures: number;
  warnings: number;
}

/** Minimal projection of `GET /me` we read for the connectivity detail. */
interface MeIdentity {
  userId?: string;
  keyId?: string;
  v3Enabled?: boolean;
  /** Account-wide membership list. Absent-safe (older backends omit it). */
  organizations?: CliOrgSummary[];
  /** The calling key's own org binding — membership keys only. */
  org?: CliOrgBinding;
}

export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Project dir for the skill check. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Runtime version string (e.g. "22.9.0"). Defaults to `process.versions.node`. */
  nodeVersion?: string;
  existsSync?: (p: string) => boolean;
}

type CommonOptions = FactoryCommonOptions;

export async function runDoctor(opts: CommonOptions, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const out = makeOutput(opts.output, deps);
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const nodeVersion = deps.nodeVersion ?? process.versions.node;

  const config = loadConfig({
    profile: opts.profile,
    endpointUrl: opts.endpointUrl,
    env,
    credentialsPath: deps.credentialsPath,
  });
  const endpointCheck = checkEndpoint(config.apiUrl);
  const hasKey = Boolean(config.apiKey);
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  const connectivity = await checkConnectivity(opts, deps, {
    hasKey,
    endpointOk: endpointCheck.status === 'ok',
  });

  const checks: DoctorCheck[] = [
    { name: 'CLI version', status: 'ok', detail: VERSION },
    checkNodeVersion(nodeVersion),
    { name: 'Profile', status: 'ok', detail: config.profile },
    endpointCheck,
    checkCredentials(hasKey, config.profile, opts.dryRun ?? false),
    connectivity.check,
  ];

  // Informational routing line, only when the backend reported it (no new call).
  if (connectivity.v3Enabled !== undefined) {
    const label = routingLabel(connectivity.v3Enabled);
    checks.push({
      name: 'Routing',
      status: 'ok',
      detail:
        connectivity.v3Enabled === true
          ? `${label} (V3 execution routing is ON)`
          : `${label} (default routing)`,
    });
  }

  // Org attribution lines — only when the backend reported them (no new call).
  const orgsSummary = formatOrgsSummary(connectivity.organizations);
  if (orgsSummary) {
    checks.push({ name: 'Organizations', status: 'ok', detail: orgsSummary });
  }
  const orgBinding = formatOrgBinding(connectivity.org);
  if (orgBinding) {
    checks.push({ name: 'Org binding', status: 'ok', detail: orgBinding });
  }
  // Warn, not fail: the key works — it just cannot see the team's work, which
  // otherwise looks like missing data rather than a scoping choice.
  const personalScopeHint = formatPersonalScopeHint(connectivity.organizations, connectivity.org);
  if (personalScopeHint) {
    checks.push({ name: 'Workspace scope', status: 'warn', detail: personalScopeHint });
  }

  checks.push(checkSkill(cwd, deps));

  const failures = checks.filter(check => check.status === 'fail').length;
  const warnings = checks.filter(check => check.status === 'warn').length;
  const report: DoctorReport = { checks, failures, warnings };

  out.print(report, () => renderDoctor(report));

  if (connectivity.v3Enabled === true) {
    emitV3RoutingAdvisory(stderr);
  }

  if (failures > 0) {
    // Non-zero exit so `testsprite doctor && ...` gates a CI step or an agent
    // preflight. The full report already printed above; this line is the stderr
    // summary index.ts renders before exiting 1.
    throw new CLIError(`doctor: ${failures} check(s) failed, ${warnings} warning(s)`, 1);
  }
  return report;
}

function checkNodeVersion(nodeVersion: string): DoctorCheck {
  // Reuse the CLI's own runtime guard so the verdict matches exactly what the
  // entrypoint enforces at startup, rather than a divergent hardcoded check.
  // The precise engines floor (20.19+/22.13+/24+) is enforced by npm at install
  // time via .npmrc engine-strict. sourceRef: src/version-guard.ts.
  const rejected = shouldRejectNodeVersion(nodeVersion);
  return {
    name: 'Node.js',
    status: rejected ? 'fail' : 'ok',
    detail: rejected
      ? `v${nodeVersion} is below the required Node ${MIN_SUPPORTED_NODE_MAJOR}; upgrade Node.js`
      : `v${nodeVersion} (>=${MIN_SUPPORTED_NODE_MAJOR} required)`,
  };
}

function checkEndpoint(apiUrl: string): DoctorCheck {
  try {
    assertValidEndpointUrl(apiUrl);
    return { name: 'API endpoint', status: 'ok', detail: apiUrl };
  } catch {
    return {
      name: 'API endpoint',
      status: 'fail',
      detail: `"${apiUrl}" is not a valid http(s) URL`,
    };
  }
}

function checkCredentials(hasKey: boolean, profile: string, dryRun: boolean): DoctorCheck {
  if (hasKey) {
    // Never print any part of the key (security). Confirm presence only.
    return {
      name: 'Credentials',
      status: 'ok',
      detail: `API key configured (profile "${profile}")`,
    };
  }
  // Under --dry-run no key is expected, so a missing key is not a failure.
  return {
    name: 'Credentials',
    status: dryRun ? 'warn' : 'fail',
    detail: dryRun
      ? 'no API key (not needed under --dry-run)'
      : 'no API key found; run `testsprite setup` (or set TESTSPRITE_API_KEY)',
  };
}

function checkSkill(cwd: string, deps: DoctorDeps): DoctorCheck {
  const installed = isVerifySkillInstalled(cwd, {
    existsSync: deps.existsSync,
  });
  return {
    name: 'Verify skill',
    status: installed ? 'ok' : 'warn',
    detail: installed
      ? 'installed in this project'
      : 'not installed here; run `testsprite setup` so your agent verifies its changes',
  };
}

async function checkConnectivity(
  opts: CommonOptions,
  deps: DoctorDeps,
  ctx: { hasKey: boolean; endpointOk: boolean },
): Promise<{
  check: DoctorCheck;
  v3Enabled?: boolean;
  organizations?: CliOrgSummary[];
  org?: CliOrgBinding;
}> {
  const name = 'Connectivity';
  if (opts.dryRun) return { check: { name, status: 'warn', detail: 'skipped under --dry-run' } };
  if (!ctx.hasKey)
    return { check: { name, status: 'warn', detail: 'skipped; no API key to test with' } };
  if (!ctx.endpointOk)
    return { check: { name, status: 'warn', detail: 'skipped; endpoint URL is invalid' } };

  try {
    const client = makeHttpClient(opts, {
      env: deps.env,
      credentialsPath: deps.credentialsPath,
      fetchImpl: deps.fetchImpl,
      stderr: deps.stderr,
    });
    const me = await client.get<MeIdentity>('/me');
    const who = me.userId ? ` (userId ${me.userId})` : '';
    return {
      check: { name, status: 'ok', detail: `reached GET /me, API key accepted${who}` },
      v3Enabled: me.v3Enabled,
      organizations: me.organizations,
      org: me.org,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      if (
        error.code === 'AUTH_REQUIRED' ||
        error.code === 'AUTH_INVALID' ||
        error.code === 'AUTH_FORBIDDEN'
      ) {
        return { check: { name, status: 'fail', detail: `API key rejected (${error.code})` } };
      }
      return { check: { name, status: 'fail', detail: `GET /me failed (${error.code})` } };
    }
    return {
      check: {
        name,
        status: 'fail',
        detail: `GET /me failed (${error instanceof Error ? error.message : String(error)})`,
      },
    };
  }
}

const STATUS_LABEL: Record<DoctorStatus, string> = {
  ok: '[OK]  ',
  warn: '[WARN]',
  fail: '[FAIL]',
};

function renderDoctor(report: DoctorReport): string {
  const nameWidth = Math.max(...report.checks.map(check => check.name.length));
  const lines: string[] = ['TestSprite doctor', ''];
  for (const check of report.checks) {
    lines.push(`  ${STATUS_LABEL[check.status]} ${check.name.padEnd(nameWidth)}  ${check.detail}`);
  }
  lines.push('');
  lines.push(
    report.failures === 0 && report.warnings === 0
      ? 'All checks passed.'
      : `${report.failures} failure(s), ${report.warnings} warning(s).`,
  );
  return lines.join('\n');
}

export function createDoctorCommand(deps: DoctorDeps = {}): Command {
  const cmd = new Command('doctor')
    .description(
      'Diagnose CLI setup: version, Node, profile, endpoint, credentials, connectivity, skill',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  testsprite doctor                 # run all checks (exit 1 if any fails)\n' +
        '  testsprite doctor --output json   # machine-readable report\n' +
        '  testsprite doctor && testsprite test run <id>   # gate a command on a healthy setup',
    )
    .action(async (_cmdOpts, command: Command) => {
      await runDoctor(resolveCommonOptions(command), deps);
    });

  return cmd;
}

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

function parseRequestTimeoutFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    // Match the other commands: a malformed --request-timeout is a validation
    // error, not a silently-ignored default.
    throw localValidationError(
      'request-timeout',
      `must be a positive number of seconds (got "${raw}")`,
    );
  }
  return Math.round(seconds * 1000);
}

function makeOutput(mode: OutputMode, deps: DoctorDeps): Output {
  return new Output(mode, { stdout: deps.stdout, stderr: deps.stderr });
}
