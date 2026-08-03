import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

interface CredentialsLockInfo {
  pid?: number;
  createdAt?: number;
  token?: string;
}

interface CredentialsLock {
  assertHeld: () => void;
  release: () => void;
}

interface RestrictiveModeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnSync?: (
    command: string,
    args: readonly string[],
    options: { shell: false; stdio: 'ignore'; windowsHide: true },
  ) => SpawnSyncReturns<Buffer>;
  warn?: (line: string) => void;
}

const FILE_KEY_TO_FIELD: Record<string, keyof ProfileEntry> = {
  api_key: 'apiKey',
  api_url: 'apiUrl',
};

const FIELD_TO_FILE_KEY: Record<keyof ProfileEntry, string> = {
  apiKey: 'api_key',
  apiUrl: 'api_url',
};

const CREDENTIALS_LOCK_RETRY_MS = 25;
const CREDENTIALS_LOCK_WAIT_MS = 5_000;
const CREDENTIALS_LOCK_STALE_MS = 30_000;

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
      // Guard against INI injection: a value containing newline characters
      // would be serialized across multiple lines, allowing an attacker to
      // inject arbitrary key-value pairs (or new section headers) into the
      // credentials file. A valid API key or URL never contains \n or \r.
      // Strip them so a compromised env var or MITM'd backend response
      // cannot override the stored api_key on subsequent reads.
      const sanitized = value.replace(/[\r\n]/g, '');
      if (sanitized === '') continue;
      lines.push(`${FIELD_TO_FILE_KEY[field]} = ${sanitized}`);
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
  mutateCredentialsFile(path, file => {
    file[profile] = { ...file[profile], ...entry };
    return file;
  });
}

export function deleteProfile(profile: string, options: CredentialsOptions = {}): boolean {
  assertValidProfileName(profile);
  const path = resolvePath(options);
  if (!existsSync(path)) return false;
  let removed = false;
  mutateCredentialsFile(path, file => {
    if (!(profile in file)) return undefined;
    removed = true;
    delete file[profile];
    return file;
  });
  return removed;
}

/**
 * Enforce restrictive access on the credentials file after atomic writes.
 * POSIX hosts use chmod(0600); Windows hosts use ACL tightening via icacls.
 */
export function ensureRestrictiveMode(path: string, options: RestrictiveModeOptions = {}): void {
  if (!existsSync(path)) return;
  if ((options.platform ?? process.platform) === 'win32') {
    ensureWindowsRestrictiveAcl(path, options);
    return;
  }
  const overpermissive = (statSync(path).mode & 0o077) !== 0;
  if (overpermissive) chmodSync(path, 0o600);
}

/**
 * Restrict a Windows credentials file to the current user using icacls.
 * The command is invoked with an args array so credential paths are never shell-interpreted.
 */
function ensureWindowsRestrictiveAcl(path: string, options: RestrictiveModeOptions): void {
  const username = (options.env ?? process.env).USERNAME?.trim();
  if (!username) {
    warnWindowsAcl(
      'could not determine the Windows username; credentials file permissions were not tightened',
      options,
    );
    return;
  }

  const run = options.spawnSync ?? spawnSync;

  // Reset to re-enable inheritance from the parent directory first.
  // Using /inheritance:r (the previous approach) strips all inherited ACEs and
  // relies solely on the USERNAME-based grant — on Windows the env USERNAME may
  // not resolve to the same SID that owns the file (e.g. Microsoft Account /
  // domain account mismatches), which leaves the file unreadable by anyone.
  // /reset restores inherited ACEs so the owner can always access the file, then
  // the explicit /grant:r adds a belt-and-suspenders Full-Control entry.
  run('icacls', [path, '/reset'], {
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });

  const result = run('icacls', [path, '/grant:r', `${username}:F`], {
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });

  if (result.error) {
    warnWindowsAcl(
      `icacls failed while tightening credentials file permissions: ${result.error.message}`,
      options,
    );
    return;
  }
  if (result.status !== 0) {
    warnWindowsAcl(
      `icacls exited with status ${result.status ?? 'unknown'}; credentials file permissions may be too broad`,
      options,
    );
  }
}

/** Emit an explicit warning when Windows ACL tightening cannot be completed. */
function warnWindowsAcl(message: string, options: RestrictiveModeOptions): void {
  const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  warn(`[warning] ${message}`);
}

function resolvePath(options: CredentialsOptions): string {
  return options.path ?? defaultCredentialsPath();
}

function mutateCredentialsFile(
  path: string,
  mutate: (file: CredentialsFile) => CredentialsFile | undefined,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = acquireCredentialsLock(path);
  try {
    const file = readCredentialsFile({ path });
    const nextFile = mutate(file);
    if (nextFile === undefined) return;
    lock.assertHeld();
    writeCredentialsAtomic(path, nextFile);
  } finally {
    lock.release();
  }
}

function writeCredentialsAtomic(path: string, file: CredentialsFile): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, serializeCredentials(file), { mode: 0o600, encoding: 'utf8' });
  renameSync(tmp, path);
  ensureRestrictiveMode(path);
}

function acquireCredentialsLock(path: string): CredentialsLock {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + CREDENTIALS_LOCK_WAIT_MS;
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const lockInfo: Required<CredentialsLockInfo> = {
    pid: process.pid,
    createdAt: Date.now(),
    token,
  };

  while (true) {
    try {
      writeFileSync(lockPath, `${JSON.stringify(lockInfo)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      return {
        assertHeld: () => assertCredentialsLockHeld(lockPath, token),
        release: () => releaseCredentialsLock(lockPath, token),
      };
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') {
        throw error;
      }

      reclaimStaleCredentialsLock(lockPath);
      if (Date.now() >= deadline) {
        throw localValidationError(
          'credentialsLock',
          'timed out waiting for another credential update to finish; retry the command',
          undefined,
          'field',
        );
      }
      sleepSync(CREDENTIALS_LOCK_RETRY_MS);
    }
  }
}

function reclaimStaleCredentialsLock(lockPath: string): void {
  let lockInfo: CredentialsLockInfo | undefined;
  try {
    lockInfo = JSON.parse(readFileSync(lockPath, 'utf-8')) as CredentialsLockInfo;
  } catch {
    lockInfo = undefined;
  }

  const createdAt = typeof lockInfo?.createdAt === 'number' ? lockInfo.createdAt : undefined;
  const ageMs = createdAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - createdAt;
  const pid = typeof lockInfo?.pid === 'number' ? lockInfo.pid : undefined;
  if (ageMs <= CREDENTIALS_LOCK_STALE_MS && (pid === undefined || isProcessAlive(pid))) {
    return;
  }

  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function assertCredentialsLockHeld(lockPath: string, token: string): void {
  const lockInfo = readCredentialsLockInfo(lockPath);
  if (lockInfo?.token === token) return;
  throw localValidationError(
    'credentialsLock',
    'lost ownership of the credential update lock; retry the command',
    undefined,
    'field',
  );
}

function releaseCredentialsLock(lockPath: string, token: string): void {
  const lockInfo = readCredentialsLockInfo(lockPath);
  if (lockInfo?.token !== token) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function readCredentialsLockInfo(lockPath: string): CredentialsLockInfo | undefined {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8')) as CredentialsLockInfo;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') return false;
    return true;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
