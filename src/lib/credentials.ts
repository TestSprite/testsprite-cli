import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
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
  withCredentialsLock(path, () => {
    const file = readCredentialsFile(options);
    file[profile] = { ...file[profile], ...entry };
    writeCredentialsAtomic(path, file);
  });
}

export function deleteProfile(profile: string, options: CredentialsOptions = {}): boolean {
  assertValidProfileName(profile);
  const path = resolvePath(options);
  return withCredentialsLock(path, () => {
    const file = readCredentialsFile(options);
    if (!(profile in file)) return false;
    delete file[profile];
    if (Object.keys(file).length === 0) {
      writeCredentialsAtomic(path, {});
    } else {
      writeCredentialsAtomic(path, file);
    }
    return true;
  });
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

/** Max wall-clock wait when another process holds the credentials lock. */
const CREDENTIALS_LOCK_MAX_WAIT_MS = 10_000;
/** Back-off between lock attempts. */
const CREDENTIALS_LOCK_RETRY_MS = 25;
/** Reclaim a lock file when the holder pid is gone or the file is older than this. */
const CREDENTIALS_LOCK_STALE_MS = 30_000;

function credentialsLockPath(credentialsPath: string): string {
  return `${credentialsPath}.lock`;
}

/**
 * Serialize read-modify-write on the credentials file across processes.
 * `writeCredentialsAtomic` only makes the final rename atomic; without this
 * lock, concurrent `writeProfile` / `deleteProfile` calls can each read the
 * same snapshot and the last rename wins — silently dropping the other update.
 */
function withCredentialsLock<T>(credentialsPath: string, fn: () => T): T {
  acquireCredentialsLock(credentialsPath);
  try {
    return fn();
  } finally {
    releaseCredentialsLock(credentialsPath);
  }
}

function acquireCredentialsLock(credentialsPath: string): void {
  const lockPath = credentialsLockPath(credentialsPath);
  // Ensure the credentials directory exists before creating the lock file.
  // writeCredentialsAtomic also mkdirs, but only after the lock is held.
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + CREDENTIALS_LOCK_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      if (isStaleCredentialsLock(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Another waiter may have claimed or released the lock.
        }
        continue;
      }
      syncSleep(CREDENTIALS_LOCK_RETRY_MS);
    }
  }
  throw new Error(`Timed out acquiring credentials lock: ${lockPath}`);
}

function releaseCredentialsLock(credentialsPath: string): void {
  try {
    unlinkSync(credentialsLockPath(credentialsPath));
  } catch {
    // Lock already released or never acquired — teardown must not mask errors.
  }
}

function isStaleCredentialsLock(lockPath: string): boolean {
  try {
    const stat = statSync(lockPath);
    if (Date.now() - stat.mtimeMs > CREDENTIALS_LOCK_STALE_MS) return true;
    const firstLine = readFileSync(lockPath, 'utf8').split('\n')[0] ?? '';
    const pid = Number.parseInt(firstLine, 10);
    if (!Number.isFinite(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

function syncSleep(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy-wait: credentials I/O is sync-only; sub-ms precision is unnecessary.
  }
}
