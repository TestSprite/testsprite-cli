import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { localValidationError } from './errors.js';

export const DEFAULT_PROFILE = 'default';

/**
 * Allowed profile-name characters. A profile name is written verbatim as an
 * INI section header (`[name]`) in the credentials file, so any character that
 * breaks that grammar must be rejected:
 *   - `]` closes the header early — `prod]` serialises to `[prod]]`, which the
 *     section regex cannot match, so the api_key/api_url lines that follow are
 *     silently dropped on read (the credential never persists).
 *   - CR/LF splits the header across lines, corrupting the file.
 *   - leading/trailing whitespace does not round-trip — the parser trims
 *     section names, so `[ prod ]` reads back as `prod`.
 * A conservative allowlist (letters, digits, dot, underscore, hyphen) matches
 * conventional profile names (`default`, `prod`, `ci-staging`, `team.qa`) and
 * cannot corrupt the file.
 */
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Throw a typed VALIDATION_ERROR (exit 5) when `profile` is not a safe INI
 * section name. Guards every credential read/write so a malformed `--profile`
 * (or `TESTSPRITE_PROFILE`) value fails loudly instead of silently corrupting
 * `~/.testsprite/credentials` or failing to persist a key written by `setup`.
 */
export function assertValidProfileName(profile: string): void {
  if (!PROFILE_NAME_RE.test(profile)) {
    throw localValidationError(
      'profile',
      'must contain only letters, digits, dot, underscore, or hyphen (no spaces, brackets, or newlines)',
      undefined,
      'flag',
    );
  }
}

export function defaultCredentialsPath(): string {
  return join(homedir(), '.testsprite', 'credentials');
}

export interface ProfileEntry {
  apiKey?: string;
  apiUrl?: string;
}

export type CredentialsFile = Record<string, ProfileEntry>;

export interface CredentialsOptions {
  path?: string;
}

const FILE_KEY_TO_FIELD: Record<string, keyof ProfileEntry> = {
  api_key: 'apiKey',
  api_url: 'apiUrl',
};

const FIELD_TO_FILE_KEY: Record<keyof ProfileEntry, string> = {
  apiKey: 'api_key',
  apiUrl: 'api_url',
};

export function parseCredentials(content: string): CredentialsFile {
  const result: CredentialsFile = {};
  let currentEntry: ProfileEntry | null = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      const sectionName = sectionMatch[1]!.trim();
      const existing = result[sectionName];
      if (existing) {
        currentEntry = existing;
      } else {
        const newEntry: ProfileEntry = {};
        result[sectionName] = newEntry;
        currentEntry = newEntry;
      }
      continue;
    }
    if (currentEntry === null) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex < 0) continue;
    const rawKey = line.slice(0, eqIndex).trim();
    const rawValue = line.slice(eqIndex + 1).trim();
    const field = FILE_KEY_TO_FIELD[rawKey];
    if (field) currentEntry[field] = rawValue;
  }
  return result;
}

export function serializeCredentials(file: CredentialsFile): string {
  const orderedSections = Object.keys(file).sort((a, b) => {
    if (a === DEFAULT_PROFILE) return -1;
    if (b === DEFAULT_PROFILE) return 1;
    return a.localeCompare(b);
  });
  const lines: string[] = [];
  for (const section of orderedSections) {
    const entry = file[section];
    if (!entry) continue;
    lines.push(`[${section}]`);
    const fields = Object.keys(entry).sort() as Array<keyof ProfileEntry>;
    for (const field of fields) {
      const value = entry[field];
      if (value === undefined || value === '') continue;
      lines.push(`${FIELD_TO_FILE_KEY[field]} = ${value}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function readCredentialsFile(options: CredentialsOptions = {}): CredentialsFile {
  const path = resolvePath(options);
  if (!existsSync(path)) return {};
  return parseCredentials(readFileSync(path, 'utf-8'));
}

export function readProfile(
  profile: string,
  options: CredentialsOptions = {},
): ProfileEntry | undefined {
  assertValidProfileName(profile);
  const file = readCredentialsFile(options);
  return file[profile];
}

export function writeProfile(
  profile: string,
  entry: ProfileEntry,
  options: CredentialsOptions = {},
): void {
  assertValidProfileName(profile);
  const path = resolvePath(options);
  const file = readCredentialsFile(options);
  file[profile] = { ...file[profile], ...entry };
  writeCredentialsAtomic(path, file);
}

export function deleteProfile(profile: string, options: CredentialsOptions = {}): boolean {
  assertValidProfileName(profile);
  const path = resolvePath(options);
  const file = readCredentialsFile(options);
  if (!(profile in file)) return false;
  delete file[profile];
  if (Object.keys(file).length === 0) {
    writeCredentialsAtomic(path, {});
  } else {
    writeCredentialsAtomic(path, file);
  }
  return true;
}

export function ensureRestrictiveMode(path: string): void {
  if (!existsSync(path)) return;
  const overpermissive = (statSync(path).mode & 0o077) !== 0;
  if (overpermissive) chmodSync(path, 0o600);
}

function resolvePath(options: CredentialsOptions): string {
  return options.path ?? defaultCredentialsPath();
}

function writeCredentialsAtomic(path: string, file: CredentialsFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, serializeCredentials(file), { mode: 0o600, encoding: 'utf8' });
  renameSync(tmp, path);
  ensureRestrictiveMode(path);
}
