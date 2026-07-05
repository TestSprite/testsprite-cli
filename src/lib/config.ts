import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PROFILE,
  defaultCredentialsPath,
  parseIniFile,
  readProfile,
} from './credentials.js';

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
  /** Settings file override; defaults to `TESTSPRITE_CONFIG_FILE` or `~/.testsprite/config`. */
  configPath?: string;
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
 * Non-credential defaults a user can persist in `~/.testsprite/config`
 * (aws-cli's credentials-vs-config split: the key lives in `credentials`,
 * settings live here). INI sections are profile names, mirroring the
 * credentials file.
 */
export interface ConfigFileSettings {
  endpointUrl?: string;
  output?: string;
  projectId?: string;
}

/** INI key -> settings field. sourceRef: DOCUMENTATION.md configuration table. */
const CONFIG_KEY_TO_FIELD: Record<string, keyof ConfigFileSettings> = {
  endpoint_url: 'endpointUrl',
  output: 'output',
  project_id: 'projectId',
};

export interface ReadConfigFileOptions {
  env?: NodeJS.ProcessEnv;
  path?: string;
}

/**
 * Read the `[profile]` section of the settings config file. Missing or
 * unreadable file (or section) yields `{}` so the cascade falls through to
 * built-in defaults; the file is optional by design. Reuses the hardened INI
 * parser the credentials file uses (null-prototype + proto-key guards).
 */
export function readConfigFileSettings(
  profile: string,
  options: ReadConfigFileOptions = {},
): ConfigFileSettings {
  const env = options.env ?? process.env;
  const path = options.path ?? env.TESTSPRITE_CONFIG_FILE ?? defaultConfigPath();
  let content: string;
  try {
    if (!existsSync(path)) return {};
    content = readFileSync(path, 'utf-8');
  } catch {
    // Unreadable settings file: settings are optional, never fatal.
    return {};
  }
  const section = parseIniFile(content)[profile];
  if (!section) return {};
  const settings: ConfigFileSettings = {};
  for (const [rawKey, field] of Object.entries(CONFIG_KEY_TO_FIELD)) {
    const value = section[rawKey];
    if (typeof value === 'string' && value.length > 0) settings[field] = value;
  }
  return settings;
}

/**
 * Resolves the active profile name and its (apiUrl, apiKey) pair.
 *
 * Resolution order, highest precedence first:
 *   profile name:  options.profile  > env.TESTSPRITE_PROFILE > "default"
 *   apiKey:        env.TESTSPRITE_API_KEY > credentials file profile entry
 *   apiUrl:        options.endpointUrl > env.TESTSPRITE_API_URL > credentials file
 *                  > config file `endpoint_url` > built-in default
 *
 * Env wins over the credentials file so CI / scripted callers can run without touching
 * the user's ~/.testsprite/credentials. The config file sits just above the built-in
 * default: it is where a user persists "this machine talks to this endpoint" once.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const profile = options.profile ?? env.TESTSPRITE_PROFILE ?? DEFAULT_PROFILE;
  const credentialsPath = options.credentialsPath ?? defaultCredentialsPath();
  const fileEntry = readProfile(profile, { path: credentialsPath });
  const settings = readConfigFileSettings(profile, { env, path: options.configPath });

  // Empty / whitespace-only env vars are treated as unset so they do not
  // short-circuit the `??` chain (e.g. `export TESTSPRITE_API_URL=` in a shell
  // profile). Matches the normalization in auth configure and init/setup.
  const envApiUrl = normalizeEnvVar(env.TESTSPRITE_API_URL);
  const envApiKey = normalizeEnvVar(env.TESTSPRITE_API_KEY);

  return {
    apiUrl:
      options.endpointUrl ??
      envApiUrl ??
      fileEntry?.apiUrl ??
      settings.endpointUrl ??
      DEFAULT_API_URL,
    apiKey: envApiKey ?? fileEntry?.apiKey,
    profile,
  };
}
