/**
 * §8.1 / M2.1 piece 4 — stdout-purity helper for `--output json` mode.
 *
 * Asserts that a CLI invocation in JSON mode produces exactly one
 * JSON document on stdout — no banners, progress lines, or extra
 * tokens. Banners and stderr-targeted hints belong on stderr; this
 * helper is the regression guard so a future code change can't
 * accidentally pollute stdout.
 *
 * Usage:
 *
 * ```ts
 * await expectJsonModeStdoutIsPureJson(() => runCli('--output json projects list'));
 * ```
 *
 * The helper accepts a `runCli` callback that returns `{ stdout,
 * stderr, code }` so it can be wired against either a subprocess
 * runner (Vitest's `execa`) or an in-process stub. Both shapes
 * produce the same answer.
 */

export interface CliInvocationResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function expectJsonModeStdoutIsPureJson(
  runCli: () => Promise<CliInvocationResult>,
): Promise<void> {
  const result = await runCli();
  const trimmed = result.stdout.trim();

  // Empty stdout is acceptable for some commands (e.g. `--out <dir>`
  // success path that writes the artifact to disk and prints the
  // confirmation on stderr). The guard here is "if anything was
  // printed, it must be a single JSON document."
  if (trimmed.length === 0) return;

  // Parse must succeed — banners or progress lines would land on
  // stdout and break JSON.parse.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `JSON-mode stdout is not parseable JSON: ${(err as Error).message}\n` +
        `--- stdout (${trimmed.length} bytes) ---\n${trimmed.slice(0, 400)}\n--- end ---`,
      { cause: err },
    );
  }

  // A single top-level JSON value is what the §8.1 contract pins. A
  // common pollution pattern is "{...}\nbanner-line\n" or "banner\n{...}".
  // After trimming, JSON.parse already accepts only one top-level
  // value — but a banner before the JSON would either parse as the
  // banner alone (bad) or fail with `Unexpected token` (caught above).
  // Defense in depth: confirm we got an object/array (not a bare
  // string banner that happens to be quoted-JSON-valid).
  if (parsed === null) return; // null is a valid top-level JSON value
  if (typeof parsed !== 'object') {
    // A bare number/string/boolean as the only stdout output would
    // also parse — but it's not what any CLI command emits.
    throw new Error(
      `JSON-mode stdout was a top-level ${typeof parsed} ('${String(parsed).slice(0, 80)}'), ` +
        `expected an object or array.`,
    );
  }
}
