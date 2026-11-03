/**
 * §8.1 — tests for the stdout-purity helper itself.
 *
 * The helper guards `--output json` mode: if a future code change
 * pollutes stdout with a banner or progress line, every command's
 * test gets noisier in a useful way. This file pins the helper's
 * own behavior so a regression in the helper doesn't silently let
 * pollution slip through.
 */

import { describe, expect, it } from 'vitest';
import { expectJsonModeStdoutIsPureJson } from './stdoutPurity.js';

describe('expectJsonModeStdoutIsPureJson', () => {
  it('accepts a single JSON object on stdout', async () => {
    await expect(
      expectJsonModeStdoutIsPureJson(async () => ({
        stdout: '{"hello":"world"}\n',
        stderr: '',
        code: 0,
      })),
    ).resolves.toBeUndefined();
  });

  it('accepts a single JSON array on stdout', async () => {
    await expect(
      expectJsonModeStdoutIsPureJson(async () => ({
        stdout: '[1,2,3]\n',
        stderr: '',
        code: 0,
      })),
    ).resolves.toBeUndefined();
  });

  it('accepts empty stdout (commands writing artifacts to disk)', async () => {
    await expect(
      expectJsonModeStdoutIsPureJson(async () => ({
        stdout: '',
        stderr: 'Bundle written to /tmp/x\n',
        code: 0,
      })),
    ).resolves.toBeUndefined();
  });

  it('accepts whitespace-only stdout (trims before parsing)', async () => {
    await expect(
      expectJsonModeStdoutIsPureJson(async () => ({
        stdout: '   \n  ',
        stderr: '',
        code: 0,
      })),
    ).resolves.toBeUndefined();
  });

  it('rejects banner-then-JSON pollution', async () => {
    await expect(
      expectJsonModeStdoutIsPureJson(async () => ({
        stdout: 'Connecting to dev backend...\n{"hello":"world"}\n',
        stderr: '',
        code: 0,
      })),
    ).rejects.toThrow(/not parseable JSON/);
  });

  it('rejects JSON-then-banner pollution', async () => {
    await expect(
      expectJsonModeStdoutIsPureJson(async () => ({
        stdout: '{"hello":"world"}\nDone.\n',
        stderr: '',
        code: 0,
      })),
    ).rejects.toThrow(/not parseable JSON/);
  });

  it('rejects a bare quoted-string banner that happens to be JSON-valid', async () => {
    await expect(
      expectJsonModeStdoutIsPureJson(async () => ({
        stdout: '"banner only"\n',
        stderr: '',
        code: 0,
      })),
    ).rejects.toThrow(/top-level string/);
  });
});
