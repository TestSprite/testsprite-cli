/**
 * Shared helper for the hidden, deprecated command aliases introduced by the
 * setup consolidation (`init`/`auth configure`/`auth whoami`/`auth logout`).
 *
 * The aliases are hidden from `--help` (so a coding agent never sees the old
 * names) but still work (so existing scripts and any agent trained on the old
 * commands keep running). When invoked, they print this one-line notice to
 * stderr — stdout stays clean so JSON pipelines are unaffected.
 */
export function emitDeprecationNotice(
  oldCmd: string,
  newCmd: string,
  stderr: (line: string) => void = (line: string) => process.stderr.write(`${line}\n`),
): void {
  stderr(`[deprecated] \`testsprite ${oldCmd}\` is deprecated — use \`testsprite ${newCmd}\`.`);
}

/** Release that deletes the commands deprecated in the 0.16 line. */
export const REMOVED_IN = '0.17.0';

/**
 * A deprecated command and the invocation that replaces it. `command` is the
 * full name (`test rerun`) so the same entry feeds the stderr notice and the
 * JSON `deprecations` key. `replacement` is a template, not a command to run
 * as is: the caller's ids and flags carry over (see the notice's advice).
 */
export interface DeprecationEntry {
  command: string;
  replacement: string;
  removedIn: string;
}

export const TEST_RERUN_DEPRECATION: DeprecationEntry = {
  command: 'test rerun',
  replacement: 'test run',
  removedIn: REMOVED_IN,
};

// `test flaky` has no replacement; `replacement` names the command that samples a test again.
export const TEST_FLAKY_DEPRECATION: DeprecationEntry = {
  command: 'test flaky',
  replacement: 'test run',
  removedIn: REMOVED_IN,
};

/**
 * `advice` replaces the default "Use `<replacement>`." sentence with command-specific
 * migration steps. `noReplacement` says so in the lead sentence for a command that is
 * deleted outright.
 */
export function deprecationNoticeLine(
  entry: DeprecationEntry,
  advice?: string,
  noReplacement = false,
): string {
  return (
    `[deprecated] \`testsprite ${entry.command}\` is deprecated and will be removed in ${entry.removedIn}` +
    (noReplacement ? ', with no replacement. ' : '. ') +
    (advice ?? `Use \`testsprite ${entry.replacement}\`.`)
  );
}

export function emitDeprecationEntry(
  entry: DeprecationEntry,
  stderr: (line: string) => void = (line: string) => process.stderr.write(`${line}\n`),
  advice?: string,
  noReplacement = false,
): void {
  stderr(deprecationNoticeLine(entry, advice, noReplacement));
}
