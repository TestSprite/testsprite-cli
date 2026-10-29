/** Individual backend definitions projected from the test and code API responses. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CliTest, CliTestCode } from '../commands/test.js';
import { localValidationError } from './errors.js';

export const MAX_DEFINITION_BYTES = 1024 * 1024;
export const MAX_DEFINITION_CODE_BYTES = 350 * 1024;

const METADATA_FIELDS = [
  'name',
  'description',
  'priority',
  'stepTimeoutMs',
  'produces',
  'consumes',
  'category',
] as const;

export interface BackendDefinitionMetadata {
  id?: string;
  projectId: string;
  type: 'backend';
  name: string;
  description?: string | null;
  priority?: string | null;
  stepTimeoutMs?: number | null;
  produces?: string[] | null;
  consumes?: string[] | null;
  category?: string | null;
}

export interface TestDefinition {
  test: BackendDefinitionMetadata;
  code: CliTestCode & { language: 'python'; framework: 'pytest' };
}

function object(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw localValidationError(field, 'must be an object', undefined, 'field');
  }
}

function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) {
    throw localValidationError(
      field,
      `contains unsupported fields: ${unknown.join(', ')}; refusing to discard them`,
      undefined,
      'field',
    );
  }
}

function string(value: unknown, field: string, max?: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || (max !== undefined && value.length > max)) {
    throw localValidationError(
      field,
      `must be a non-empty string${max === undefined ? '' : ` of at most ${max} characters`}`,
      undefined,
      'field',
    );
  }
}

/** Reject unsupported fields before any request so imports cannot silently lose data. */
export function parseTestDefinition(value: unknown): TestDefinition {
  object(value, 'definition');
  keys(value, ['test', 'code'], 'definition');
  object(value.test, 'test');
  object(value.code, 'code');
  const test = value.test;
  const code = value.code;
  keys(test, ['id', 'projectId', 'type', ...METADATA_FIELDS], 'test');
  keys(code, ['testId', 'language', 'framework', 'code', 'codeVersion', 'etag'], 'code');
  if (test.type !== 'backend') {
    throw localValidationError(
      'test.type',
      'definition export/import currently supports backend tests only; frontend plans cannot be restored by this command',
      undefined,
      'field',
    );
  }
  string(test.projectId, 'test.projectId');
  string(test.name, 'test.name', 200);
  if (test.id !== undefined) string(test.id, 'test.id');
  for (const field of ['description', 'category'] as const) {
    const entry = test[field];
    if (entry !== undefined && entry !== null && typeof entry !== 'string') {
      throw localValidationError(`test.${field}`, 'must be a string or null', undefined, 'field');
    }
  }
  if (typeof test.description === 'string' && test.description.length > 2000) {
    throw localValidationError(
      'test.description',
      'must be at most 2000 characters',
      undefined,
      'field',
    );
  }
  if (
    test.priority !== undefined &&
    test.priority !== null &&
    (typeof test.priority !== 'string' ||
      !['p0', 'p1', 'p2', 'p3', 'high', 'medium', 'low'].includes(
        test.priority.trim().toLowerCase(),
      ))
  ) {
    throw localValidationError(
      'test.priority',
      'must be p0, p1, p2, p3, high, medium, low (case-insensitive), or null',
      undefined,
      'field',
    );
  }
  if (
    test.stepTimeoutMs !== undefined &&
    test.stepTimeoutMs !== null &&
    (!Number.isInteger(test.stepTimeoutMs) ||
      Number(test.stepTimeoutMs) < 1 ||
      Number(test.stepTimeoutMs) > 60000)
  ) {
    throw localValidationError(
      'test.stepTimeoutMs',
      'must be an integer from 1 to 60000 or null',
      undefined,
      'field',
    );
  }
  for (const field of ['produces', 'consumes'] as const) {
    const entry = test[field];
    if (
      entry !== undefined &&
      entry !== null &&
      (!Array.isArray(entry) || entry.some(item => typeof item !== 'string' || !item.trim()))
    ) {
      throw localValidationError(
        `test.${field}`,
        'must be an array of non-empty strings or null',
        undefined,
        'field',
      );
    }
  }
  string(code.testId, 'code.testId');
  if (test.id !== undefined && test.id !== code.testId) {
    throw localValidationError('code.testId', 'must match test.id', undefined, 'field');
  }
  if (code.language !== 'python' || code.framework !== 'pytest') {
    throw localValidationError(
      'code',
      'backend imports require Python/pytest source',
      undefined,
      'field',
    );
  }
  assertDefinitionCode(code.code);
  if (code.codeVersion !== null) string(code.codeVersion, 'code.codeVersion');
  if (code.etag !== undefined && code.etag !== null) string(code.etag, 'code.etag');
  return value as unknown as TestDefinition;
}

export function assertDefinitionCode(value: unknown): asserts value is string {
  string(value, 'code.code');
  if (value.startsWith('https://')) {
    throw localValidationError(
      'code.code',
      'must contain source, not an expiring code URL',
      undefined,
      'field',
    );
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_DEFINITION_CODE_BYTES) {
    throw localValidationError(
      'code.code',
      'exceeds the 350 KB code input limit',
      undefined,
      'field',
    );
  }
}

/** Runtime state and result fields are outside the definition projection. */
export function projectTestDefinition(test: CliTest, code: CliTestCode): TestDefinition {
  const projected: Record<string, unknown> = {
    id: test.id,
    projectId: test.projectId,
    type: test.type,
  };
  for (const field of METADATA_FIELDS) {
    if (Object.hasOwn(test, field)) projected[field] = test[field];
  }
  return parseTestDefinition({ test: projected, code });
}

/** Create treats null optional values as unset; update preserves explicit clears. */
export function definitionMetadata(
  test: BackendDefinitionMetadata,
  create: boolean,
): Record<string, unknown> {
  return Object.fromEntries(
    METADATA_FIELDS.filter(
      field => test[field] !== undefined && (!create || test[field] !== null),
    ).map(field => [field, test[field]]),
  );
}

export function stringifyTestDefinition(definition: TestDefinition): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, sort(entry)]),
      );
    }
    return value;
  };
  return `${JSON.stringify(sort(definition), null, 2)}\n`;
}

/** Use one nonblocking descriptor, rejecting devices/FIFOs and bounding actual bytes. */
export function readDefinitionFileGuarded(path: string): TestDefinition {
  const absolute = resolve(path);
  let fd: number | undefined;
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-selected file; fstat and bounded reads use this single descriptor, without resolving the path again.
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile()) throw localValidationError('file', `not a regular file: ${path}`);
    if (info.size > MAX_DEFINITION_BYTES)
      throw localValidationError('file', 'exceeds the 1 MB definition input limit');
    const buffer = Buffer.alloc(MAX_DEFINITION_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const size = readSync(fd, buffer, count, buffer.length - count, null);
      if (size === 0) break;
      count += size;
    }
    if (count > MAX_DEFINITION_BYTES)
      throw localValidationError('file', 'exceeds the 1 MB definition input limit');
    raw = buffer
      .subarray(0, count)
      .toString('utf8')
      .replace(/^\uFEFF/, '');
  } catch (error) {
    if (error instanceof Error && 'exitCode' in error) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT'
        ? 'file does not exist'
        : code === 'EACCES' || code === 'EPERM'
          ? 'permission denied reading file'
          : 'cannot read regular file';
    throw localValidationError('file', `${reason}: ${path}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw localValidationError('file', 'not valid JSON');
  }
  return parseTestDefinition(parsed);
}
