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

/** Minimum Node.js major version supported by the CLI (matches package.json `engines.node`). */
export const MIN_SUPPORTED_NODE_MAJOR = 20;

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

/**
 * Decide whether the given Node.js version is too old to run the CLI.
 *
 * A version is rejected only when its major number is a real value below
 * {@link MIN_SUPPORTED_NODE_MAJOR}. An unparseable string yields `NaN`, which is
 * treated as "do not reject" so the guard never blocks on a version string it
 * cannot understand (the runtime would surface any real incompatibility itself).
 *
 * @param nodeVersion - a `process.versions.node` style string (e.g. `"18.19.1"`).
 * @returns `true` when the runtime is below the supported floor and should be rejected.
 */
export function shouldRejectNodeVersion(nodeVersion: string): boolean {
  const major = parseMajorVersion(nodeVersion);
  return !Number.isNaN(major) && major < MIN_SUPPORTED_NODE_MAJOR;
}
