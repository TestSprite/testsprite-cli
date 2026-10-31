import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeWithBom, readTextFileBomAware } from './text-file.js';

const PAYLOAD = '{"projectId":"project_alice","type":"frontend","name":"checkout"}';

function encoded(payload: string, enc: 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be'): Buffer {
  if (enc === 'utf8') return Buffer.from(payload, 'utf8');
  if (enc === 'utf8-bom')
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(payload, 'utf8')]);
  if (enc === 'utf16le')
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(payload, 'utf16le')]);
  const body = Buffer.from(payload, 'utf16le');
  body.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
}

describe('decodeWithBom', () => {
  for (const enc of ['utf8', 'utf8-bom', 'utf16le', 'utf16be'] as const) {
    it(`decodes ${enc}`, () => {
      expect(decodeWithBom(encoded(PAYLOAD, enc))).toBe(PAYLOAD);
    });
  }

  it('passes BOM-less UTF-8 through unchanged', () => {
    const raw = Buffer.from(PAYLOAD, 'utf8');
    expect(decodeWithBom(raw)).toBe(PAYLOAD);
    expect(decodeWithBom(raw)).toBe(raw.toString('utf8'));
  });

  it('handles an empty buffer', () => {
    expect(decodeWithBom(Buffer.alloc(0))).toBe('');
  });
});

describe('readTextFileBomAware', () => {
  it('reads a UTF-16LE file written by PowerShell 5.1 `>` back intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'text-file-'));
    const path = join(dir, 'plan.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- `path` is this test's own mkdtempSync file, never user input
    writeFileSync(path, encoded(PAYLOAD, 'utf16le'));
    expect(readTextFileBomAware(path)).toBe(PAYLOAD);
  });
});
