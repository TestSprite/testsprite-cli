import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCreateBatch, runCreateFromPlan, runLint } from './test.js';
import { ApiError } from '../lib/errors.js';

/**
 * Integration tests for issue #463: the CLI's own docs suggest creating plan
 * files with shell redirection, and Windows PowerShell 5.1's `>` writes
 * UTF-16LE with a BOM. Every encoding the default Windows shell can produce
 * must lint (and therefore create) cleanly.
 */
const PLAN = {
  projectId: 'project_alice',
  type: 'frontend',
  name: 'checkout',
  description: 'BOM encoding matrix',
  planSteps: [{ type: 'action', description: 'navigate to home' }],
};

type BomEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be';

function writeEncoded(dir: string, name: string, payload: string, enc: BomEncoding): string {
  const path = join(dir, name);
  let bytes: Buffer;
  if (enc === 'utf8') {
    bytes = Buffer.from(payload, 'utf8');
  } else if (enc === 'utf8-bom') {
    bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(payload, 'utf8')]);
  } else if (enc === 'utf16le') {
    bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(payload, 'utf16le')]);
  } else {
    const body = Buffer.from(payload, 'utf16le');
    body.swap16();
    bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
  }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- `path` is this test's own mkdtempSync file, never user input
  writeFileSync(path, bytes);
  return path;
}

describe('plan files saved with a BOM (PowerShell 5.1 `>`) lint cleanly', () => {
  for (const enc of ['utf16le', 'utf16be', 'utf8-bom', 'utf8'] as const) {
    it(`lints a ${enc} plan file with zero issues`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bom-plan-'));
      const path = writeEncoded(dir, `plan-${enc}.json`, JSON.stringify(PLAN, null, 2), enc);
      const report = await runLint({
        profile: 'default',
        output: 'json',
        debug: false,
        planFrom: path,
      });
      expect(report.checked).toBe(1);
      expect(report.issues).toEqual([]);
    });
  }

  it('an odd-byte UTF-16BE plan file fails create with the typed encoding error, not a crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bom-plan-'));
    const body = Buffer.from(JSON.stringify(PLAN, null, 2), 'utf16le');
    body.swap16();
    const path = join(dir, 'plan-utf16be-odd.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- `path` is this test's own mkdtempSync file, never user input
    writeFileSync(path, Buffer.concat([Buffer.from([0xfe, 0xff]), body, Buffer.from([0x00])]));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- credentials fixture inside the same mkdtempSync dir, never user input
    writeFileSync(
      join(dir, 'credentials'),
      '[default]\napi_url = http://localhost:13502\napi_key = sk-user-test\n',
    );
    const deps = {
      credentialsPath: join(dir, 'credentials'),
      fetchImpl: (() => {
        throw new Error('unexpected network');
      }) as typeof fetch,
      stdout: () => {},
      stderr: () => {},
    };
    // Plan parsing fires before any network; the typed localValidationError
    // (not a raw ERR_INVALID_BUFFER_SIZE) is what reaches the caller. The
    // human-readable text rides on nextAction (envelope message is generic).
    const err: unknown = await runCreateFromPlan(
      { profile: 'default', output: 'json', debug: false, planFrom: path },
      deps as never,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(String((err as { nextAction?: string }).nextAction)).toContain('incomplete code unit');
  });
});

describe('plan-from-dir caps the batch on raw bytes, not decoded length', () => {
  it('a UTF-16 directory whose raw bytes exceed 5 MB fails with PAYLOAD_TOO_LARGE before any network', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bom-dir-'));
    // One valid (small) plan so the batch would otherwise assemble cleanly.
    writeEncoded(dir, '01-plan.json', JSON.stringify(PLAN, null, 2), 'utf16le');
    // One non-plan JSON file (skipped by the plan heuristic AFTER being read)
    // whose RAW UTF-16LE bytes blow the 5 MB cap while its decoded length
    // stays well under it — the exact gap a decoded-length check misses.
    // 2.7 MB of ASCII decodes from ~5.4 MB of UTF-16LE.
    const padding = `{"padding":"${'x'.repeat(2_700_000)}"}`;
    writeEncoded(dir, '02-padding.json', padding, 'utf16le');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- credentials fixture inside the same mkdtempSync dir, never user input
    writeFileSync(
      join(dir, 'credentials'),
      '[default]\napi_url = http://localhost:13502\napi_key = sk-user-test\n',
    );
    const deps = {
      credentialsPath: join(dir, 'credentials'),
      fetchImpl: (() => {
        throw new Error('unexpected network');
      }) as typeof fetch,
      stdout: () => {},
      stderr: () => {},
    };
    const err: unknown = await runCreateBatch(
      { profile: 'default', output: 'json', debug: false, plans: '', planFromDir: dir },
      deps as never,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(String((err as { nextAction?: string }).nextAction)).toContain(
      'multiple smaller directories',
    );
  });
});
