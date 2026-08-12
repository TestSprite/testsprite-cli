/**
 * Node.js runtime version guard.
 *
 * The CLI targets modern Node (see `engines.node` in package.json). Running on
 * an older runtime tends to fail later with a cryptic ESM/syntax error, so the
 * entrypoint (`src/index.ts`) uses {@link shouldRejectNodeVersion} to exit early
 * with a clear, actionable message instead.
 *
 * The logic lives here (rather than inline) so it can be unit-tested against the
 * real implementation the entrypoint uses — not a copy.
 */

/** Canonical supported range, pinned to package.json by the unit test. */
export const SUPPORTED_NODE_ENGINE = '^20.19.0 || ^22.13.0 || >=24';
/** Human-readable form of the supported range for startup errors. */
export const SUPPORTED_NODE_RANGE = '20.19+, 22.13+, or 24+';
export const MIN_SUPPORTED_NODE_MAJOR = 20;
const MIN_NODE_20_MINOR = 19;
const MIN_NODE_22_MINOR = 13;

/**
 * Parse the leading major version number from a Node.js version string.
 *
 * @param nodeVersion - a dot-separated version string such as `process.versions.node`
 *   (e.g. `"20.11.1"`). A leading `v` is not expected (Node does not include one here).
 * @returns the major version as a number, or `NaN` if the string has no numeric leading segment.
 */
export function parseMajorVersion(nodeVersion: string): number {
  return Number(nodeVersion.split('.')[0]);
}

function parseMajorMinor(nodeVersion: string): { major: number; minor: number } | null {
  const [majorRaw, minorRaw] = nodeVersion.split('.');
  const major = Number(majorRaw);
  // Preserve the old guard's behavior for injectable major-only versions such as "18".
  const minor = minorRaw === undefined ? 0 : Number(minorRaw);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 0 || minor < 0) {
    return null;
  }
  return { major, minor };
}

/**
 * Decide whether the given Node.js version is outside the supported engine range.
 *
 * Mirrors `^20.19.0 || ^22.13.0 || >=24`: Node 20 is supported from 20.19,
 * Node 22 from 22.13, odd intermediate majors 21/23 are rejected, and 24+ is supported.
 * An unparseable string is treated as "do not reject" so the guard never blocks on a
 * version string it cannot understand (the runtime would surface any incompatibility).
 *
 * @param nodeVersion - a `process.versions.node` style string (e.g. `"18.19.1"`).
 * @returns `true` when the runtime is unsupported and should be rejected.
 */
export function shouldRejectNodeVersion(nodeVersion: string): boolean {
  const parsed = parseMajorMinor(nodeVersion);
  if (parsed === null) return false;

  const { major, minor } = parsed;
  if (major < MIN_SUPPORTED_NODE_MAJOR) return true;
  if (major === 20) return minor < MIN_NODE_20_MINOR;
  if (major === 21) return true;
  if (major === 22) return minor < MIN_NODE_22_MINOR;
  if (major === 23) return true;
  return false;
}
