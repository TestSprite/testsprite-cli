import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROFILE, defaultCredentialsPath, readProfile } from './credentials.js';

export interface Config {
  apiUrl: string;
  apiKey?: string;
  profile: string;
}

export interface LoadConfigOptions {
  profile?: string;
  endpointUrl?: string;
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
}

export const DEFAULT_API_URL = 'https://api.testsprite.com';

/** Treat empty / whitespace-only env values as unset for `??` resolution chains. */
export function normalizeEnvVar(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function defaultConfigPath(): string {
  return join(homedir(), '.testsprite', 'config');
}

/**
 * The single place the documented profile-resolution order lives:
 *
 *   `--profile` flag  >  `TESTSPRITE_PROFILE` env var  >  `"default"`
 *
 * Every command needs the resolved name before it can build a client (and
 * `auth` / `setup` need it to read and write the right credentials section), so
 * each one used to inline `flag ?? 'default'`. That collapsed to the literal
 * `'default'` whenever the flag was absent and made the env var unreachable
 * from every entry point — `loadConfig` never got the `undefined` its own `??`
 * chain needs. Resolving here keeps the order in one place and keeps the
 * blank-value normalization ({@link normalizeEnvVar}) that a hand-written
 * `flag ?? env.TESTSPRITE_PROFILE ?? 'default'` would drop: an empty or
 * whitespace-only value must fall back to the default profile, not fail the
 * INI section-name guard on every command.
 */
export function resolveProfileName(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return flagValue ?? normalizeEnvVar(env.TESTSPRITE_PROFILE) ?? DEFAULT_PROFILE;
}

/**
 * Resolves the active profile name and its (apiUrl, apiKey) pair.
 *
 * Resolution order, highest precedence first:
 *   profile name:  options.profile  > env.TESTSPRITE_PROFILE > "default"
 *   apiKey:        env.TESTSPRITE_API_KEY > credentials file profile entry
 *   apiUrl:        options.endpointUrl > env.TESTSPRITE_API_URL > credentials file > built-in default
 *
 * Env wins over the credentials file so CI / scripted callers can run without touching
 * the user's ~/.testsprite/credentials.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const profile = resolveProfileName(options.profile, env);
  const credentialsPath = options.credentialsPath ?? defaultCredentialsPath();
  const fileEntry = readProfile(profile, { path: credentialsPath });

  // Empty / whitespace-only env vars are treated as unset so they do not
  // short-circuit the `??` chain (e.g. `export TESTSPRITE_API_URL=` or
  // `export TESTSPRITE_PROFILE=` in a shell profile). For the profile this
  // also avoids a confusing VALIDATION_ERROR: an empty name fails the INI
  // section-name guard, so without normalization a blank env var would break
  // every command instead of falling back to the default profile. Matches the
  // normalization in auth configure and init/setup.
  const envApiUrl = normalizeEnvVar(env.TESTSPRITE_API_URL);
  const envApiKey = normalizeEnvVar(env.TESTSPRITE_API_KEY);

  return {
    apiUrl: options.endpointUrl ?? envApiUrl ?? fileEntry?.apiUrl ?? DEFAULT_API_URL,
    apiKey: envApiKey ?? fileEntry?.apiKey,
    profile,
  };
}
