import type * as NodeFsPromises from 'node:fs/promises';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renameMock = vi.hoisted(() => vi.fn());
const rmMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async importOriginal => {
  const actual = (await importOriginal()) as typeof NodeFsPromises;
  return {
    ...actual,
    rename: renameMock,
    rm: rmMock,
  };
});

const { commitBundle } = await import('./bundle.js');

describe('commitBundle', () => {
  let realRename: typeof NodeFsPromises.rename;
  let realRm: typeof NodeFsPromises.rm;

  beforeEach(async () => {
    const actual = (await vi.importActual('node:fs/promises')) as typeof NodeFsPromises;
    realRename = actual.rename;
    realRm = actual.rm;
    renameMock.mockImplementation(realRename);
    rmMock.mockImplementation(realRm);
  });

  afterEach(() => {
    renameMock.mockReset();
    rmMock.mockReset();
  });

  async function withTempParent(run: (parent: string) => Promise<void>): Promise<void> {
    const parent = mkdtempSync(join(tmpdir(), 'bundle-commit-parent-'));
    try {
      await run(parent);
    } finally {
      await realRm(parent, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  function seedBundleDirs(parent: string): { dir: string; tmpDir: string; files: string[] } {
    const dir = join(parent, 'bundle');
    const tmpDir = join(dir, '.tmp');

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'foreign notes\n', 'utf8');
    mkdirSync(join(dir, 'steps'), { recursive: true });
    writeFileSync(join(dir, 'meta.json'), '{"snapshotId":"snap_old"}\n', 'utf8');
    writeFileSync(join(dir, 'steps', '01-evidence.json'), '{"step":1}\n', 'utf8');

    mkdirSync(join(tmpDir, 'steps'), { recursive: true });
    writeFileSync(join(tmpDir, 'meta.json'), '{"snapshotId":"snap_new"}\n', 'utf8');
    writeFileSync(join(tmpDir, 'result.json'), '{}\n', 'utf8');
    writeFileSync(join(tmpDir, 'steps', '01-evidence.json'), '{"step":9}\n', 'utf8');

    return { dir, tmpDir, files: ['result.json', 'meta.json', 'steps/01-evidence.json'] };
  }

  it('rolls back to the prior complete bundle when a staged rename fails', async () => {
    await withTempParent(async parent => {
      const { dir, tmpDir, files } = seedBundleDirs(parent);

      renameMock.mockImplementation(async (oldPath, newPath) => {
        const dest = String(newPath);
        if (dest.endsWith('result.json') && !dest.includes('.aside.')) {
          throw Object.assign(new Error('simulated install failure'), { code: 'EACCES' });
        }
        return realRename(oldPath, newPath);
      });

      await expect(commitBundle(tmpDir, dir, files)).rejects.toThrow('simulated install failure');

      expect(readFileSync(join(dir, 'meta.json'), 'utf8')).toBe('{"snapshotId":"snap_old"}\n');
      expect(readFileSync(join(dir, 'steps', '01-evidence.json'), 'utf8')).toBe('{"step":1}\n');
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('foreign notes\n');
      const leftovers = readdirSync(parent).filter(name => name.includes('.aside.'));
      expect(leftovers).toEqual([]);
    });
  });

  it('preserves foreign files while installing the new bundle on success', async () => {
    await withTempParent(async parent => {
      const { dir, tmpDir, files } = seedBundleDirs(parent);

      await expect(commitBundle(tmpDir, dir, files)).resolves.toBeUndefined();

      expect(readFileSync(join(dir, 'meta.json'), 'utf8')).toBe('{"snapshotId":"snap_new"}\n');
      expect(readFileSync(join(dir, 'steps', '01-evidence.json'), 'utf8')).toBe('{"step":9}\n');
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('foreign notes\n');
      expect(existsSync(join(dir, 'result.json'))).toBe(true);
    });
  });

  it('keeps the new bundle when post-commit aside cleanup fails', async () => {
    await withTempParent(async parent => {
      const { dir, tmpDir, files } = seedBundleDirs(parent);

      rmMock.mockImplementation(async (path, options) => {
        if (String(path).includes('.aside.')) {
          throw Object.assign(new Error('simulated aside cleanup failure'), { code: 'EACCES' });
        }
        return realRm(path, options);
      });

      await expect(commitBundle(tmpDir, dir, files)).resolves.toBeUndefined();

      expect(readFileSync(join(dir, 'meta.json'), 'utf8')).toBe('{"snapshotId":"snap_new"}\n');
      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('foreign notes\n');
    });
  });
});
