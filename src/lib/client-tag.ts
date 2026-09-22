/**
 * Optional "client" identity a wrapper can stamp onto every request the CLI
 * makes on its behalf — the GitHub Action sets `TESTSPRITE_CLIENT=github-action/<ref>`
 * so the backend can tell an Action-driven run from a developer's shell without
 * a second credential or a new header.
 *
 * Wire shape: the User-Agent becomes `testsprite-cli/<version> (<client>)`.
 * Without the env var (or with an invalid value) the UA is byte-identical to
 * what it has always been, `testsprite-cli/<version>`.
 *
 * The value is validated against a tight grammar — `<name>/<version>` where the
 * name is lowercase alphanumeric plus `-` (≤32 chars) and the version is a
 * short token of `[0-9A-Za-z._+-]` (≤40 chars) — so a caller can never smuggle
 * header-breaking characters (spaces, parentheses, CR/LF) or free text into a
 * request header. An invalid value is dropped silently and NEVER echoed: the
 * tag rides on telemetry too, and a rejected value must not leak back into a
 * log line either.
 */
import { VERSION } from '../version.js';

/** Env var a wrapper (e.g. the GitHub Action) sets to identify itself. */
export const CLIENT_TAG_ENV = 'TESTSPRITE_CLIENT';

/** `<name>/<version>`: e.g. `github-action/v1`, `github-action/1.2.0`. */
const CLIENT_TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}\/[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;

/**
 * The validated client tag from `env`, or undefined when unset or invalid.
 * Pure — reads only the one variable it owns.
 */
export function resolveClientTag(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[CLIENT_TAG_ENV];
  if (typeof raw !== 'string') return undefined;
  return CLIENT_TAG_RE.test(raw) ? raw : undefined;
}

/**
 * The User-Agent every outgoing request (API + telemetry beacon) sends.
 * `testsprite-cli/<version>`, with ` (<client>)` appended only for a valid
 * {@link CLIENT_TAG_ENV} value.
 */
export function buildUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  const base = `testsprite-cli/${VERSION}`;
  const client = resolveClientTag(env);
  return client === undefined ? base : `${base} (${client})`;
}
