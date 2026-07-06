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

const DEFAULT_API_URL = 'https://api.testsprite.com';

/** Treat empty / whitespace-only env values as unset for `??` resolution chains. */
export function normalizeEnvVar(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function defaultConfigPath(): string {
  return join(homedir(), '.testsprite', 'config');
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
  const profile = options.profile ?? env.TESTSPRITE_PROFILE ?? DEFAULT_PROFILE;
  const credentialsPath = options.credentialsPath ?? defaultCredentialsPath();
  const fileEntry = readProfile(profile, { path: credentialsPath });

  // Empty / whitespace-only env vars are treated as unset so they do not
  // short-circuit the `??` chain (e.g. `export TESTSPRITE_API_URL=` in a shell
  // profile). Matches the normalization in auth configure and init/setup.
  const envApiUrl = normalizeEnvVar(env.TESTSPRITE_API_URL);
  const envApiKey = normalizeEnvVar(env.TESTSPRITE_API_KEY);

  return {
    apiUrl: options.endpointUrl ?? envApiUrl ?? fileEntry?.apiUrl ?? DEFAULT_API_URL,
    apiKey: envApiKey ?? fileEntry?.apiKey,
    profile,
  };
}
