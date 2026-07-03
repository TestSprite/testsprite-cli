/**
 * §6.7 FailureContext bundle writer.
 *
 * Given a `FailureContext` JSON envelope (returned by
 * `GET /api/cli/v1/tests/{id}/failure`), `writeBundle` dereferences
 * every presigned URL into local bytes and writes the §7 disk layout
 * under `<dir>`. The contract is "agent-safe" — every guarantee in
 * the FailureContext spec §3 + §7 is enforced here:
 *
 *   1. **Atomic** — every artifact in the bundle came from one
 *      `snapshotId`. We refuse a forged response where
 *      `bundle.snapshotId !== result.snapshotId` or steps disagree on
 *      `runIdIfAvailable` (`assertContextIntegrity`).
 *   2. **Atomic on disk** — we write to `<dir>/.tmp/...` first and
 *      `rename()` each file into place. `meta.json` is renamed last so
 *      the presence of `<dir>/meta.json` ⇔ "bundle is complete and
 *      self-consistent".
 *   3. **`.partial` on failure** — any download or fs failure leaves
 *      a `<dir>/.partial` marker (with `requestId`, error summary,
 *      snapshotId) and exits non-zero. Agents check `.partial` before
 *      consuming.
 *   4. **Bounded budget** — the writer streams URL → file (no full-
 *      buffer), so a 200MB video doesn't sit in V8's heap.
 *
 * What this module deliberately does NOT do:
 *
 *   - Re-derive `snapshotId`. The CLI trusts whatever the facade
 *     returned. A snapshotId mismatch is a backend bug and we surface
 *     it as a typed validation error rather than try to "heal" it.
 *   - Generate `summary` strings. Those are server-side per §6.1 of
 *     the spec; the CLI emits whatever the facade produced.
 *   - Resume after a partial bundle. M2 always re-fetches from scratch
 *     when the agent re-runs. M3 may add resume.
 */

import { mkdir, mkdtemp, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { createWriteStream } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { CliFailureContext, CliTestStep } from '../commands/test.js';
import { ApiError, TransportError, localValidationError } from './errors.js';
import { requireEnum } from './validate.js';
import type { FetchImpl } from './http.js';

/** Schema version stamped into `meta.json`. Bumps with the contract. */
export const BUNDLE_SCHEMA_VERSION = 'cli-v1' as const;

/** Max fetch attempts for each presigned URL (initial + retries). */
export const STREAM_URL_MAX_RETRIES = 3;
/** Delay between retries for transient transport failures (ms). */
export const STREAM_URL_RETRY_DELAY_MS = 1000;

/** Default radius around the failed step when `--failed-only` is set. */
export const FAILED_ONLY_RADIUS = 1;

/**
 * Sentinel reasons emitted on the `details.reason` field when the
 * integrity check throws. Exported so callers can branch on a typed
 * literal rather than parsing the message text.
 */
export type BundleIntegrityReason =
  | 'snapshot_id_mismatch'
  | 'run_id_mismatch'
  | 'code_version_mismatch'
  | 'evidence_missing_failed_step'
  | 'run_id_missing'
  | 'test_id_mismatch';

/**
 * Options for {@link assertContextIntegrity}.
 */
export interface AssertContextIntegrityOptions {
  /**
   * When `true`, the run-scoped path requires `ctx.meta.runId` (i.e.,
   * `ctx.result.runIdIfAvailable`) to be present. M2 callers pass
   * `{}` (or omit entirely) to preserve the opt-in behavior.
   */
  requireRunId?: boolean;
}

/**
 * Identity card written as `<dir>/meta.json`. Agents read this first —
 * if any other file's `snapshotId` disagrees, the bundle is corrupt
 * and they must refuse to act.
 *
 * `runIdIfAvailable` and `codeVersion` are surfaced from `result`
 * (already shared across every step in a valid bundle, so the meta
 * carries the bundle-wide value rather than the per-step one).
 */
export interface BundleMeta {
  schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  snapshotId: string;
  testId: string;
  projectId: string;
  codeVersion: string | null;
  runIdIfAvailable: string | null;
  targetUrl: string | null;
  failedStepIndex: number | null;
  failureKind: string | null;
  /** When the backend captured the snapshot. Mirrors `result.finishedAt`. */
  capturedAt: string | null;
  /** When the CLI fetched the bundle (this run's clock). */
  fetchedAt: string;
}

export interface WriteBundleOptions {
  /** Absolute or relative target directory. */
  dir: string;
  /** Apply the §7.4 `--failed-only` filter (failed step ± 1) before downloading. */
  failedOnly: boolean;
  /** Custom fetch impl for tests. Defaults to global `fetch`. */
  fetchImpl?: FetchImpl;
  /** Server requestId to embed in `.partial` on failure. */
  requestId?: string;
}

export interface WriteBundleResult {
  meta: BundleMeta;
  /** Absolute path of the bundle directory. */
  dir: string;
  /** Files actually written, relative to `dir`. */
  files: string[];
}

/**
 * Compose the FailureContext spec §3 invariants into a single
 * trip wire. Throwing here is the agent-safety gate — we trust the
 * facade for the data, not for self-consistency.
 *
 *   - Bundle-level `snapshotId` MUST equal `result.snapshotId`.
 *   - All steps in the bundle MUST share `runIdIfAvailable` (or all
 *     be `null`). Mixed values means a stitched read leaked through.
 *
 * The error envelope is `VALIDATION_ERROR` rather than `INTERNAL`
 * because the operator-facing remediation is "retry once" (the
 * snapshot may genuinely have been mid-mutation; a fresh fetch will
 * succeed). `requestId` is the original request id so support can
 * trace the bad envelope back.
 */
export function assertContextIntegrity(
  ctx: CliFailureContext,
  requestId: string,
  opts?: AssertContextIntegrityOptions,
): void {
  if (opts?.requireRunId && !ctx.result.runIdIfAvailable) {
    throw bundleIntegrityError(
      'run_id_missing',
      'meta.runId (result.runIdIfAvailable) is required for run-scoped bundles but is null or missing',
      requestId,
    );
  }
  if (ctx.snapshotId !== ctx.result.snapshotId) {
    throw bundleIntegrityError(
      'snapshot_id_mismatch',
      `Bundle integrity check failed: expected snapshotId=${ctx.snapshotId} got snapshotId=${ctx.result.snapshotId}`,
      requestId,
      { expectedSnapshotId: ctx.snapshotId, actualSnapshotId: ctx.result.snapshotId },
    );
  }
  // Per codex round-1 P2: every embedded testId must equal ctx.testId.
  // §6.X duplicates `testId` in `result`, `code`, and each step so a
  // bundle stitched together from rows of two different tests is
  // detectable without external state. Without this gate, an agent
  // could open `meta.json` for `test_A`, edit the file the bundle
  // claims is its code, and have the edit actually target `test_B`'s
  // source — exactly the cross-test contamination the failure bundle
  // exists to prevent.
  if (ctx.result.testId !== ctx.testId) {
    throw bundleIntegrityError(
      'test_id_mismatch',
      `Bundle integrity check failed: expected testId=${ctx.testId} got testId=${ctx.result.testId} (in result)`,
      requestId,
      { expectedTestId: ctx.testId, actualTestId: ctx.result.testId },
    );
  }
  if (ctx.code.testId !== ctx.testId) {
    throw bundleIntegrityError(
      'test_id_mismatch',
      `Bundle integrity check failed: expected testId=${ctx.testId} got testId=${ctx.code.testId} (in code)`,
      requestId,
      { expectedTestId: ctx.testId, actualTestId: ctx.code.testId },
    );
  }
  for (const step of ctx.steps) {
    if (step.testId !== ctx.testId) {
      throw bundleIntegrityError(
        'test_id_mismatch',
        `Bundle integrity check failed: expected testId=${ctx.testId} got testId=${step.testId} (in step[${step.stepIndex}])`,
        requestId,
        { expectedTestId: ctx.testId, actualTestId: step.testId },
      );
    }
  }
  // §6.7: code is "version pinned to result.codeVersion." If both
  // sides are non-null and disagree, the bundle stitched code from
  // one version with a result from another — exactly the drift case
  // the failure bundle exists to prevent. Both-null is fine (the M2
  // backend hasn't shipped versioning yet); only mismatched pairs
  // are corrupt.
  if (
    ctx.result.codeVersion !== null &&
    ctx.code.codeVersion !== null &&
    ctx.result.codeVersion !== ctx.code.codeVersion
  ) {
    throw bundleIntegrityError(
      'code_version_mismatch',
      `Bundle integrity check failed: expected codeVersion=${ctx.result.codeVersion} got codeVersion=${ctx.code.codeVersion}`,
      requestId,
      { expectedCodeVersion: ctx.result.codeVersion, actualCodeVersion: ctx.code.codeVersion },
    );
  }
  // Only DISTINCT NON-NULL runIds indicate cross-run stitching. A `null`
  // `runIdIfAvailable` just means that step row predates runId stamping —
  // FE Portal step rows accumulate across runs and older rows were never
  // stamped, so a multi-run test legitimately carries a mix of one real
  // runId and several nulls. Counting null as a distinct value made
  // `test failure get <test-id>` permanently fail on any test that ran
  // more than once across the M3.1 cutover, and the "re-fetch usually
  // succeeds" hint was wrong because the null is durable, not transient
  // (dogfood 2026-06-04). Tolerate null; flag only when ≥2 *real* runIds
  // are present (genuine cross-run stitching). The run-scoped path below
  // (`requireRunId`) keeps the stricter per-step equality check.
  const nonNullRunIds = new Set<string>();
  for (const step of ctx.steps) {
    if (step.runIdIfAvailable != null) nonNullRunIds.add(step.runIdIfAvailable);
  }
  if (nonNullRunIds.size > 1) {
    const runIdList = [...nonNullRunIds];
    throw bundleIntegrityError(
      'run_id_mismatch',
      `Bundle integrity check failed: steps carry mixed runIds [${runIdList.join(', ')}]`,
      requestId,
      { observedRunIds: runIdList },
    );
  }

  // Run-scoped path: additionally assert that every step's runIdIfAvailable
  // matches result.runIdIfAvailable. The check above only catches steps
  // that disagree with *each other*; a backend stitching all steps from
  // "run_other" into a result for "run_abc" would pass the set-size check
  // (all steps agree) but fail here.
  //
  // Also assert per-step codeVersion matches result.codeVersion when both
  // are present — a mixed version bundle could point an agent at the wrong
  // fix target.
  if (opts?.requireRunId) {
    const expectedRunId = ctx.result.runIdIfAvailable!; // guarded by run_id_missing check above
    const resultCodeVersion = ctx.result.codeVersion;
    for (const step of ctx.steps) {
      if (step.runIdIfAvailable !== expectedRunId) {
        throw bundleIntegrityError(
          'run_id_mismatch',
          `Bundle integrity check failed: expected runId=${expectedRunId} got runId=${String(step.runIdIfAvailable)} (in step[${step.stepIndex}])`,
          requestId,
          { expectedRunId, actualRunId: step.runIdIfAvailable },
        );
      }
      if (
        resultCodeVersion !== null &&
        step.codeVersion !== null &&
        step.codeVersion !== resultCodeVersion
      ) {
        throw bundleIntegrityError(
          'code_version_mismatch',
          `Bundle integrity check failed: expected codeVersion=${resultCodeVersion} got codeVersion=${step.codeVersion} (in step[${step.stepIndex}])`,
          requestId,
          { expectedCodeVersion: resultCodeVersion, actualCodeVersion: step.codeVersion },
        );
      }
    }
  }
  if (ctx.failure.evidence.length > 0 && ctx.result.failedStepIndex !== null) {
    const hasFailedStep = ctx.failure.evidence.some(
      e => e.stepIndex === ctx.result.failedStepIndex,
    );
    if (!hasFailedStep) {
      // §6.2: when evidence[] is non-empty, at least one entry must
      // attach to the failed step so an agent can route on it.
      throw bundleIntegrityError(
        'evidence_missing_failed_step',
        `bundle evidence does not include failedStepIndex=${ctx.result.failedStepIndex}`,
        requestId,
      );
    }
  }
}

/**
 * Apply the `--failed-only` filter — drop neighbor steps and their
 * evidence, keep the failed step. Idempotent: returns `ctx` unchanged
 * when `failedStepIndex` is null (no step-level diagnosis to filter)
 * or when the existing window already matches.
 */
export function applyFailedOnly(ctx: CliFailureContext): CliFailureContext {
  const failedIdx = ctx.result.failedStepIndex;
  if (failedIdx === null) return ctx;
  const inWindow = (idx: number) => Math.abs(idx - failedIdx) <= FAILED_ONLY_RADIUS;
  const filteredSteps = ctx.steps.filter(s => inWindow(s.stepIndex));
  const filteredEvidence = ctx.failure.evidence.filter(e => inWindow(e.stepIndex));
  return {
    ...ctx,
    steps: filteredSteps,
    failure: { ...ctx.failure, evidence: filteredEvidence },
  };
}

/**
 * Resolve the user-supplied `--out` path into an absolute directory.
 * Empty strings are rejected with `VALIDATION_ERROR` for consistency
 * with `test code get --out`. We do NOT pre-create the directory or
 * its `.tmp` child — `writeBundle` mkdir's after the integrity check
 * passes so a forged response never modifies the operator's filesystem.
 */
export function resolveBundleDir(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request.',
        nextAction: 'Flag `--out` is invalid: must be a non-empty directory path.',
        requestId: 'local',
        details: { field: 'out', reason: 'must be a non-empty directory path' },
      },
    });
  }
  const trimmed = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

/**
 * Pick a code-file extension for `<dir>/code.<ext>` based on the §6.3
 * `language` + `framework`. The extension matches the test code's
 * language, not the user-app code under test.
 */
export function pickCodeExtension(language: string, framework: string): string {
  if (language === 'python') return 'py';
  if (language === 'javascript') return 'js';
  if (language === 'typescript') return 'ts';
  // Fallback when the server didn't stamp a language: both TestSprite
  // frameworks are Python — backend `pytest` and frontend Playwright
  // (`playwright.async_api`) — so default to `.py`. (Legacy TS/JS rows
  // carry an explicit `language` above and are honored as `.ts`/`.js`.)
  if (framework === 'pytest') return 'py';
  return 'py';
}

/**
 * Step filename per §7.2 — 1-based index, zero-padded to two digits
 * for indices ≤ 99, three digits for ≥ 100. `${stepIndex}-snapshot.html`
 * etc. Never truncates: an agent constructing the path with
 * `padStart(2, '0')` works for the common case, and step ≥ 100 widens
 * naturally without breaking existing fixtures.
 */
export function stepFilenamePrefix(stepIndex: number): string {
  return stepIndex >= 100 ? String(stepIndex).padStart(3, '0') : String(stepIndex).padStart(2, '0');
}

/**
 * Refuse a composed artifact path that escapes `baseDir`. Step filenames are
 * built from response-controlled fields, so this is the final containment
 * check before any write. Returns the validated absolute path.
 */
export function assertNoEscape(baseDir: string, segment: string): string {
  const composed = resolve(baseDir, segment);
  const rel = relative(baseDir, composed);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw localValidationError(
      'out',
      'resolved artifact path escapes the bundle directory',
      undefined,
      'field',
    );
  }
  return composed;
}

/**
 * Build the §7.1 meta.json given a context. Pure function, no I/O —
 * lets specs assert the meta shape without touching disk.
 */
export function buildMeta(ctx: CliFailureContext, fetchedAt: Date = new Date()): BundleMeta {
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    snapshotId: ctx.snapshotId,
    testId: ctx.testId,
    projectId: ctx.projectId,
    codeVersion: ctx.code.codeVersion ?? ctx.result.codeVersion ?? null,
    runIdIfAvailable: ctx.result.runIdIfAvailable,
    targetUrl: ctx.result.targetUrl,
    failedStepIndex: ctx.result.failedStepIndex,
    failureKind: ctx.result.failureKind,
    capturedAt: ctx.result.finishedAt,
    fetchedAt: fetchedAt.toISOString(),
  };
}

/**
 * Top-level bundle writer. The order matters:
 *
 *   1. `assertContextIntegrity` — fail closed on a forged envelope.
 *   2. `applyFailedOnly` — narrow before download (saves bytes).
 *   3. `mkdir <dir>/.tmp/` — fresh; clean any stale temp.
 *   4. `writeFile result.json / failure.json / code.<ext>` — local data.
 *   5. `fetch + stream` for `video.mp4` (when set) and per-step
 *      snapshot/screenshot/evidence-json files.
 *   6. `writeFile meta.json` LAST — its presence means "bundle complete".
 *   7. `rename .tmp/<file> -> <file>` for every file. Last rename
 *      makes meta.json visible.
 *
 * On any failure between (3) and (6), write a `<dir>/.partial` marker
 * and re-throw so `index.ts` produces a typed exit code (UNAVAILABLE
 * → 10 by default; the original ApiError is preserved when applicable).
 */
export async function writeBundle(
  ctx: CliFailureContext,
  options: WriteBundleOptions,
): Promise<WriteBundleResult> {
  const requestId = options.requestId ?? 'local';
  assertContextIntegrity(ctx, requestId);

  const filtered = options.failedOnly ? applyFailedOnly(ctx) : ctx;
  // Re-check after filtering — in theory a buggy filter could leave a
  // mismatched evidence list. Cheap defense-in-depth.
  assertContextIntegrity(filtered, requestId);

  const dir = resolveBundleDir(options.dir);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const meta = buildMeta(filtered);
  const codeExt = pickCodeExtension(filtered.code.language, filtered.code.framework);

  await mkdir(dir, { recursive: true });
  // Fresh `.tmp/` each run. A previous SIGKILL'd run can leave bytes
  // behind; we don't want to mix them with the new fetch.
  const tmpDir = await freshTmpDir(dir);
  const stepsTmpDir = join(tmpDir, 'steps');
  await mkdir(stepsTmpDir, { recursive: true });

  const filesWritten: string[] = [];

  try {
    // result.json + failure.json + code.<ext> are local writes; no
    // network, no streaming.
    await writeFile(
      join(tmpDir, 'result.json'),
      JSON.stringify(filtered.result, null, 2) + '\n',
      'utf8',
    );
    filesWritten.push('result.json');

    await writeFile(
      join(tmpDir, 'failure.json'),
      JSON.stringify(filtered.failure, null, 2) + '\n',
      'utf8',
    );
    filesWritten.push('failure.json');

    const codeFile = `code.${codeExt}`;
    if (isPresignedUrl(filtered.code.code)) {
      // §6.3 alt: when the `code` field is a presigned URL (>= 100 KB
      // bodies), stream the URL into the file rather than embedding
      // the URL in code.<ext>. M2's backend hasn't shipped the
      // >=100KB branch yet, but the contract supports it.
      await streamUrlToFile(filtered.code.code, join(tmpDir, codeFile), fetchImpl);
    } else {
      await writeFile(join(tmpDir, codeFile), filtered.code.code, 'utf8');
    }
    filesWritten.push(codeFile);

    // Optional video. Wire field is `result.videoUrl` (not in `failure`),
    // and the CLI surfaces it as a top-level on-disk artifact for agent
    // ergonomics — the agent doesn't have to know which sub-object held
    // it on the wire.
    if (filtered.result.videoUrl) {
      await streamUrlToFile(filtered.result.videoUrl, join(tmpDir, 'video.mp4'), fetchImpl);
      filesWritten.push('video.mp4');
    }

    for (const step of filtered.steps) {
      await writeStepArtifacts(
        step,
        filtered.failure.evidence,
        stepsTmpDir,
        fetchImpl,
        filesWritten,
      );
    }

    // meta.json LAST. Its presence is the sentinel that the bundle
    // is complete. An agent that opens <dir> and finds meta.json can
    // safely consume.
    await writeFile(join(tmpDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
    filesWritten.push('meta.json');

    // Atomic rename: move every file from <dir>/.tmp/* into <dir>/*.
    // Steps subdir gets renamed wholesale; meta.json renames last so
    // its visibility implies "bundle is complete and atomic on disk."
    await commitBundle(tmpDir, dir, filesWritten);

    return { meta, dir, files: filesWritten };
  } catch (err) {
    await writePartialMarker(dir, err, requestId, ctx.snapshotId).catch(() => undefined);
    throw err;
  }
}

/**
 * Make a fresh `<dir>/.tmp/` directory, removing any pre-existing
 * orphaned tmp from a prior aborted run. Using `mkdtemp` would dodge
 * the rm step but would make the rename target unpredictable; this
 * way the temp path is stable (`<dir>/.tmp`) so a SIGKILL between two
 * runs doesn't leave a tree of `.tmp.<rand>` directories.
 */
async function freshTmpDir(dir: string): Promise<string> {
  const tmpDir = join(dir, '.tmp');
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  return tmpDir;
}

/**
 * Rename `<tmp>/<file>` → `<dir>/<file>` for every file in `files`.
 *
 * Critical ordering for atomicity (the §3 "agent-safe" contract):
 *
 *   1. **Remove the OLD `meta.json` first.** The bundle's completion
 *      signal is `meta.json`'s presence; an agent reading `<dir>` while
 *      we're mutating it must see "no meta → bundle absent or
 *      mid-write" rather than "meta points at a snapshot that's already
 *      been partially overwritten." Removing the old meta is what
 *      makes the rest of the swap safe to do in place.
 *   2. Wipe stale top-level files (e.g. an old `video.mp4` when the new
 *      bundle has no video). Without this, a fresh bundle could ship
 *      with a stale video lingering at the top level.
 *   3. Replace `<dir>/steps/` wholesale.
 *   4. Rename top-level files into place.
 *   5. **Rename `meta.json` LAST.** Its visible presence is the atomic
 *      completion signal; until step 5 lands, agents see "incomplete."
 *
 * The window between (1) and (5) is bounded by a handful of `rename`
 * syscalls — small enough that a SIGKILL there is rare, and any agent
 * caught reading the dir during it sees no meta and refuses to consume
 * (per §7.3). That's what we want.
 */
/**
 * Whether a top-level directory entry belongs to the bundle format —
 * i.e. something a prior `writeBundle` could have produced and this
 * commit is therefore allowed to clean up. `code.<ext>` is matched by
 * pattern (not the current run's extension) so a stale `code.py` is
 * still swept when the new bundle writes `code.ts`. Everything else in
 * the directory is the user's and must never be deleted (`--out` can
 * point at a pre-existing, populated directory).
 */
export function isBundleOwnedEntry(entry: string): boolean {
  if (
    entry === 'result.json' ||
    entry === 'failure.json' ||
    entry === 'video.mp4' ||
    entry === 'meta.json' ||
    entry === 'steps' ||
    entry === '.tmp' ||
    entry === '.partial'
  ) {
    return true;
  }
  return /^code\.[A-Za-z0-9]+$/.test(entry);
}

async function commitBundle(
  tmpDir: string,
  dir: string,
  files: ReadonlyArray<string>,
): Promise<void> {
  // (1) Remove the prior bundle's completion signal FIRST.
  await unlink(join(dir, 'meta.json')).catch(() => undefined);

  // (2) Sweep stale top-level files that the new bundle won't write.
  // If the prior run wrote `video.mp4` and the new run has no video,
  // an in-place rename leaves the old video lingering. Only entries the
  // bundle format OWNS are candidates: `--out` may point at a directory
  // that also holds the user's unrelated files, and those must survive
  // the commit (deleting them would be silent data loss).
  const topLevel = files.filter(f => !f.startsWith('steps/'));
  const newTopLevelSet = new Set(topLevel);
  newTopLevelSet.add('meta.json'); // about to land last, do not delete
  const existing = await readdir(dir).catch(() => [] as string[]);
  for (const entry of existing) {
    // Preserve the writer's own scratch dir + the .partial marker
    // (we'll re-evaluate .partial at the end of commit). Any other
    // bundle-owned entry not-listed in the new bundle is stale.
    if (entry === '.tmp' || entry === '.partial') continue;
    if (newTopLevelSet.has(entry)) continue;
    if (entry === 'steps') continue; // handled below
    if (!isBundleOwnedEntry(entry)) continue; // foreign file — never touch
    await rm(join(dir, entry), { recursive: true, force: true });
  }

  // (3) Replace `<dir>/steps/` with `<tmp>/steps/`.
  const stepsTmp = join(tmpDir, 'steps');
  const stepsDir = join(dir, 'steps');
  await rm(stepsDir, { recursive: true, force: true });
  if (await dirExists(stepsTmp)) {
    await rename(stepsTmp, stepsDir);
  }

  // (4) Top-level files (result/failure/code/video). meta.json renames
  // LAST; track it separately.
  const metaIdx = topLevel.indexOf('meta.json');
  const beforeMeta = metaIdx >= 0 ? topLevel.filter((_, i) => i !== metaIdx) : topLevel;
  for (const file of beforeMeta) {
    await rename(join(tmpDir, file), join(dir, file));
  }

  // (5) meta.json LAST → atomic completion signal.
  if (metaIdx >= 0) {
    await rename(join(tmpDir, 'meta.json'), join(dir, 'meta.json'));
  }

  // .partial from a prior aborted run is now stale. Remove it so an
  // agent inspecting the dir sees only the fresh bundle.
  await unlink(join(dir, '.partial')).catch(() => undefined);

  // Clean up the now-empty tmp dir.
  await rm(tmpDir, { recursive: true, force: true });
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Write per-step artifacts under `<tmp>/steps/`. Each step gets up to
 * three files: `<NN>-screenshot.png` (when a screenshot URL exists —
 * M2 backend never sets one yet), `<NN>-snapshot.html` (when
 * `htmlSnapshotUrl` exists), and `<NN>-evidence.json` (a small JSON
 * file containing the non-snapshot evidence summaries — log/network/
 * console — for that step). The evidence-json file is omitted when
 * there's nothing to put in it; it's NOT a placeholder.
 */
async function writeStepArtifacts(
  step: CliTestStep,
  allEvidence: ReadonlyArray<CliFailureContext['failure']['evidence'][number]>,
  stepsTmpDir: string,
  fetchImpl: FetchImpl,
  filesWritten: string[],
): Promise<void> {
  // stepIndex comes straight from the response and is used to build the
  // filename — reject anything that isn't a real index before composing a path.
  if (!Number.isInteger(step.stepIndex) || step.stepIndex < 0) {
    throw localValidationError('stepIndex', 'must be a non-negative integer', undefined, 'field');
  }
  const prefix = stepFilenamePrefix(step.stepIndex);

  if (step.screenshotUrl) {
    const file = `${prefix}-screenshot.png`;
    await streamUrlToFile(step.screenshotUrl, assertNoEscape(stepsTmpDir, file), fetchImpl);
    filesWritten.push(`steps/${file}`);
  }

  if (step.htmlSnapshotUrl) {
    const file = `${prefix}-snapshot.html`;
    await streamUrlToFile(step.htmlSnapshotUrl, assertNoEscape(stepsTmpDir, file), fetchImpl);
    filesWritten.push(`steps/${file}`);
  }

  // Evidence sidecar artifacts. Per codex round-1 P2: the bundle must
  // be self-contained — every `evidence[].url` in the failure response
  // resolves to a local file by the time `meta.json` is written. The
  // earlier filter dropped screenshot/snapshot kinds on the assumption
  // they were always duplicates of `step.screenshotUrl` /
  // `step.htmlSnapshotUrl`, but if the evidence carries a different URL
  // (different snapshot variant, a per-evidence sidecar shot, etc.) the
  // bundle silently lost it and `failure.json` still referenced an
  // expiring presigned link. Rule now: include every evidence entry;
  // remap to the existing step file when URLs match, download a fresh
  // sidecar otherwise.
  //
  // Critical: leaving any URL inside `<NN>-evidence.json` means the
  // bundle claims completeness but actually points at presigned URLs
  // that expire after 15 min — an agent opening the bundle one hour
  // later would see metadata referencing dead links. Streaming the
  // bytes here makes the bundle self-contained.
  const sidecar = allEvidence.filter(e => e.stepIndex === step.stepIndex);
  if (sidecar.length > 0) {
    const dereferenced = await Promise.all(
      sidecar.map(async (entry, i) => {
        // kind comes from the response and is used in the filename — validate it.
        requireEnum('kind', entry.kind, ['screenshot', 'snapshot', 'log', 'network', 'console']);
        // Reuse the already-downloaded step file when the evidence URL
        // matches the step's primary screenshot/snapshot URL. Cheap
        // dedupe — no extra HTTP round-trip, no duplicate bytes on disk.
        if (entry.kind === 'screenshot' && step.screenshotUrl && step.screenshotUrl === entry.url) {
          return {
            kind: entry.kind,
            stepIndex: entry.stepIndex,
            summary: entry.summary,
            path: `steps/${prefix}-screenshot.png`,
          };
        }
        if (
          entry.kind === 'snapshot' &&
          step.htmlSnapshotUrl &&
          step.htmlSnapshotUrl === entry.url
        ) {
          return {
            kind: entry.kind,
            stepIndex: entry.stepIndex,
            summary: entry.summary,
            path: `steps/${prefix}-snapshot.html`,
          };
        }
        const ext = sidecarExtension(entry.kind);
        const filename = `${prefix}-${entry.kind}-${i}.${ext}`;
        await streamUrlToFile(entry.url, assertNoEscape(stepsTmpDir, filename), fetchImpl);
        filesWritten.push(`steps/${filename}`);
        return {
          kind: entry.kind,
          stepIndex: entry.stepIndex,
          summary: entry.summary,
          // Replace the (soon-expired) URL with a path relative to the
          // bundle root so an agent can resolve it without ambient
          // knowledge of the bundle's working directory.
          path: `steps/${filename}`,
        };
      }),
    );
    const file = `${prefix}-evidence.json`;
    await writeFile(
      assertNoEscape(stepsTmpDir, file),
      JSON.stringify(dereferenced, null, 2) + '\n',
      'utf8',
    );
    filesWritten.push(`steps/${file}`);
  }
}

function sidecarExtension(kind: 'log' | 'network' | 'console' | 'screenshot' | 'snapshot'): string {
  if (kind === 'network' || kind === 'console') return 'json';
  if (kind === 'screenshot') return 'png';
  if (kind === 'snapshot') return 'html';
  // log evidence is text-shaped — `.txt` is the safest default. The
  // actual content-type the URL serves may be log-specific (e.g.
  // .ndjson for stream-of-events logs); we don't try to guess.
  return 'txt';
}

/**
 * Stream a presigned URL into a file with bounded retry on transport
 * failures. 4xx (presigned URL expired or unauthorized) is NOT
 * retried — the URL won't recover on its own; an upstream re-fetch
 * is the only fix. Maps to `UNAVAILABLE` so `index.ts` exits 10.
 *
 * Streaming uses `pipeline` to honor backpressure: a slow disk pauses
 * the upstream reader rather than buffering chunks in V8 heap. This
 * matters for video files (multi-MB) and for very large HTML
 * snapshots.
 *
 * Transport failures (network reset, DNS blip, mid-stream EOF) are
 * retried up to STREAM_URL_MAX_RETRIES times with a fixed delay.
 * Presigned URLs are valid for 15 minutes, so retries are safe.
 */
export async function streamUrlToFile(
  url: string,
  filePath: string,
  fetchImpl: FetchImpl,
  deps?: { sleep?: (ms: number) => Promise<void> },
): Promise<void> {
  const sleepFn = deps?.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= STREAM_URL_MAX_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < STREAM_URL_MAX_RETRIES) {
        await sleepFn(STREAM_URL_RETRY_DELAY_MS);
        continue;
      }
      throw new TransportError(`Failed to download presigned URL ${url}: ${message}`);
    }
    if (!response.ok) {
      // Non-2xx: the URL itself is bad (expired, unauthorized, not found).
      // Retrying the same URL won't help — surface immediately.
      throw ApiError.fromEnvelope({
        error: {
          code: 'UNAVAILABLE',
          message: `Failed to download presigned URL (HTTP ${response.status}).`,
          nextAction:
            'Re-run `testsprite test failure get`. Presigned URLs in the bundle expire after 15 minutes.',
          requestId: 'local',
          details: { status: response.status, url },
        },
      });
    }
    if (!response.body) {
      // Some test runtimes / fetch polyfills don't expose `body` as a
      // ReadableStream. Fall back to a buffered write — same correctness,
      // just no streaming benefit. The bundle is bounded by the
      // backend's 15-min TTL, so even a multi-MB video buffers fully in
      // a tolerable amount of memory.
      try {
        const buffer = Buffer.from(await response.arrayBuffer());
        await writeFile(filePath, buffer);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < STREAM_URL_MAX_RETRIES) {
          await sleepFn(STREAM_URL_RETRY_DELAY_MS);
          continue;
        }
        throw new TransportError(`Failed to download presigned URL ${url}: ${message}`);
      }
    }
    await mkdir(dirname(filePath), { recursive: true });
    // `response.body` is a Web ReadableStream. Node's `pipeline` accepts
    // it via `Readable.fromWeb` (Node >= 18). Wrap in a try so any error
    // from the stream propagates as a TransportError, preserving the
    // exit-code contract. `pipeline` destroys both streams on error, so
    // a new WriteStream on retry starts clean.
    const fileSink = createWriteStream(filePath);
    try {
      const webBody = response.body as unknown as NodeReadableStream<Uint8Array>;
      const { Readable } = await import('node:stream');
      const nodeStream = Readable.fromWeb(webBody);
      await pipeline(nodeStream, fileSink as unknown as Writable);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < STREAM_URL_MAX_RETRIES) {
        await sleepFn(STREAM_URL_RETRY_DELAY_MS);
        continue;
      }
      throw new TransportError(`Failed mid-download of ${url}: ${message}`);
    }
  }
}

function isPresignedUrl(value: string): boolean {
  return value.startsWith('https://');
}

/**
 * Write `<dir>/.partial` so an agent inspecting the dir can detect
 * an aborted bundle. The marker is small JSON — the contract is "if
 * `.partial` exists, do not consume `<dir>` until the CLI is re-run
 * and `.partial` disappears."
 *
 * We DO NOT clean the `.tmp/` contents on partial — leaving them on
 * disk is intentional for forensics. The next successful `writeBundle`
 * call clears them.
 */
async function writePartialMarker(
  dir: string,
  err: unknown,
  requestId: string,
  snapshotId: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const body = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    snapshotId,
    requestId,
    error: err instanceof Error ? err.message : String(err),
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(dir, '.partial'), JSON.stringify(body, null, 2) + '\n', 'utf8');
}

function bundleIntegrityError(
  reason: BundleIntegrityReason,
  message: string,
  requestId: string,
  ids?: Record<string, string | string[] | null>,
): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR',
      message,
      nextAction:
        'Re-run `testsprite test failure get`. The backend may have been mid-snapshot — a fresh fetch usually succeeds. Report the requestId to support if it persists.',
      requestId,
      details: { reason, ...(ids ?? {}) },
    },
  });
}

// Avoid unused-import lint warning for the `mkdtemp` and `readdir`
// helpers reserved for forensics + future resume work.
void mkdtemp;
void readdir;
