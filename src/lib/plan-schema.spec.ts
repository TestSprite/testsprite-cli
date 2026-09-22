/**
 * `schemas/plan.schema.json` conformance tests.
 *
 * Guards the "three surfaces, one schema" contract:
 *
 *   1. The schema file is itself valid JSON Schema (ajv can compile it).
 *   2. The schema accepts/rejects a handful of fixture plans EXACTLY the way
 *      the real validator (`assertPlanShape`, reached here through the
 *      public `runCreateFromPlan` entry point — the same one `test create
 *      --plan-from` uses) accepts/rejects them. If the two ever disagree,
 *      that's a drift bug this test is designed to catch.
 *   3. `PLAN_TEMPLATE_WITH_SCHEMA` (== `test create --plan-template`'s
 *      stdout, == the example embedded in `test create --help`) validates
 *      against the schema.
 *
 * Fixtures mirror the four scenarios: (1) top-level array, (2)
 * steps nested under `plan.steps`, (3) missing `projectId`, and (4) a
 * `{{...}}` placeholder — which is intentionally VALID (advisory-only, not
 * a shape violation) per both the schema and the validator.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  PLAN_SCHEMA_URL,
  PLAN_TEMPLATE_TEXT,
  PLAN_TEMPLATE_WITH_SCHEMA,
  runCreateFromPlan,
} from '../commands/test.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', '..', 'schemas', 'plan.schema.json');

function writePlanFile(dir: string, plan: unknown): string {
  const path = join(dir, `plan-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, typeof plan === 'string' ? plan : JSON.stringify(plan), 'utf8');
  return path;
}

/**
 * Runs the fixture through the SAME validator `test create --plan-from`
 * uses (`assertPlanShape`, reached via the public `runCreateFromPlan`
 * entry point — `assertPlanShape` itself is module-private). `--dry-run`
 * still runs the full local validation pass while making no network calls and needing no credentials
 * file, so this is reproducible with zero ambient environment state.
 */
async function passesRealValidator(dir: string, plan: unknown): Promise<boolean> {
  const planFile = writePlanFile(dir, plan);
  try {
    await runCreateFromPlan(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        planFrom: planFile,
        dryRun: true,
        endpointUrl: 'https://api.testsprite.com',
      },
      { stdout: () => undefined, stderr: () => undefined },
    );
    return true;
  } catch {
    return false;
  }
}

describe('schemas/plan.schema.json', () => {
  let schema: unknown;
  let validate: ValidateFunction;
  let dir: string;

  beforeAll(() => {
    schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    // strict: false — the schema uses a `description` keyword on every node
    // (documentation, not validation) which ajv's strict mode otherwise
    // warns about; allErrors surfaces every violation for easier debugging.
    const ajv = new Ajv({ allErrors: true, strict: false });
    validate = ajv.compile(schema as object);
    dir = mkdtempSync(join(tmpdir(), 'cli-plan-schema-'));
  });

  it('is itself valid JSON Schema (ajv compiles it without throwing)', () => {
    expect(schema).toBeTruthy();
    expect(typeof validate).toBe('function');
  });

  // The schema's own `$id` (an identity, not a
  // fetch instruction) intentionally stays pinned to the canonical `main`
  // URL, while `PLAN_SCHEMA_URL` (embedded in generated plan files as the
  // `$schema` fetch hint) is intentionally version-pinned to the running
  // CLI's `v<VERSION>` tag — a plan authored against this CLI version should
  // always resolve the SAME schema, not whatever `main` contains later. The
  // two are deliberately DIFFERENT values; this test locks in that they stay
  // on their respective branch/tag conventions rather than accidentally
  // converging (or diverging further) on a future edit.
  it('`$id` stays pinned to `main` (identity) while `PLAN_SCHEMA_URL` is pinned to a version tag (fetch hint) — see PLAN_SCHEMA_URL doc comment', () => {
    const id = (schema as { $id?: string }).$id;
    expect(id).toBe(
      'https://raw.githubusercontent.com/TestSprite/testsprite-cli/main/schemas/plan.schema.json',
    );
    expect(PLAN_SCHEMA_URL).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/TestSprite\/testsprite-cli\/v\d+\.\d+\.\d+\/schemas\/plan\.schema\.json$/,
    );
    expect(PLAN_SCHEMA_URL).not.toBe(id);
  });

  it('accepts the canonical plan template (also asserted against the real validator)', async () => {
    expect(validate(PLAN_TEMPLATE_WITH_SCHEMA)).toBe(true);
    expect(await passesRealValidator(dir, PLAN_TEMPLATE_WITH_SCHEMA)).toBe(true);
  });

  it('PLAN_TEMPLATE_TEXT is exactly JSON.stringify(PLAN_TEMPLATE_WITH_SCHEMA, null, 2) — no hand-formatted drift', () => {
    expect(PLAN_TEMPLATE_TEXT).toBe(JSON.stringify(PLAN_TEMPLATE_WITH_SCHEMA, null, 2));
    // And the rendered text must itself round-trip through JSON.parse + the schema.
    expect(validate(JSON.parse(PLAN_TEMPLATE_TEXT))).toBe(true);
  });

  it('accepts a plan exercising every optional field (description, priority)', async () => {
    const plan = {
      projectId: 'prj_abc123',
      type: 'frontend',
      name: 'Full-featured plan',
      description: 'Exercises every optional field.',
      priority: 'p0',
      planSteps: [
        { type: 'action', description: 'do a thing' },
        { type: 'assertion', description: 'verify a thing' },
      ],
    };
    expect(validate(plan)).toBe(true);
    expect(await passesRealValidator(dir, plan)).toBe(true);
  });

  it('rejects type: "backend" — schema is the ground truth for the --plan-from COMMAND, which rejects backend end-to-end (both sides must agree)', async () => {
    const plan = { ...PLAN_TEMPLATE_WITH_SCHEMA, type: 'backend' };
    expect(validate(plan)).toBe(false);
    expect(await passesRealValidator(dir, plan)).toBe(false);
  });

  it('accepts a non-string `$schema` — the CLI ignores it entirely (assertPlanShape has no additionalProperties check), so the schema leaves it type-unconstrained to match (both sides must agree)', async () => {
    const plan = { ...PLAN_TEMPLATE_WITH_SCHEMA, $schema: 123 };
    expect(validate(plan)).toBe(true);
    expect(await passesRealValidator(dir, plan)).toBe(true);
  });

  // -- fixture #1: top-level array -----------------------------------
  it('rejects a top-level array (matches the real validator: "must be a JSON object")', async () => {
    const plan = [PLAN_TEMPLATE_WITH_SCHEMA];
    expect(validate(plan)).toBe(false);
    expect(await passesRealValidator(dir, plan)).toBe(false);
  });

  // -- fixture #2: steps nested under plan.steps ---------------------
  it('rejects steps nested under `plan.steps` (missing top-level planSteps; matches the real validator)', async () => {
    const plan = {
      projectId: 'prj_abc123',
      type: 'frontend',
      name: 'x',
      plan: { steps: [{ type: 'action', description: 'go' }] },
    };
    expect(validate(plan)).toBe(false);
    expect(await passesRealValidator(dir, plan)).toBe(false);
  });

  // -- fixture #3: missing projectId ----------------------------------
  it('rejects a plan missing projectId (matches the real validator)', async () => {
    const plan = {
      type: 'frontend',
      name: 'x',
      planSteps: [{ type: 'action', description: 'go' }],
    };
    expect(validate(plan)).toBe(false);
    expect(await passesRealValidator(dir, plan)).toBe(false);
  });

  // -- fixture #4: {{placeholder}} — VALID shape, advisory-only ------
  it('accepts a plan with a `{{VAR}}` placeholder step (structurally valid — the CLI advisory is a separate content-quality check)', async () => {
    const plan = {
      ...PLAN_TEMPLATE_WITH_SCHEMA,
      planSteps: [{ type: 'action', description: 'log in as {{LOGIN_USER}}' }],
    };
    expect(validate(plan)).toBe(true);
    expect(await passesRealValidator(dir, plan)).toBe(true);
  });

  it('rejects an empty planSteps array (min 1) and one exceeding 200 items (max)', () => {
    expect(validate({ ...PLAN_TEMPLATE_WITH_SCHEMA, planSteps: [] })).toBe(false);
    const tooMany = Array.from({ length: 201 }, (_, i) => ({
      type: 'action' as const,
      description: `step ${i}`,
    }));
    expect(validate({ ...PLAN_TEMPLATE_WITH_SCHEMA, planSteps: tooMany })).toBe(false);
  });

  it('rejects an invalid planSteps[].type and an invalid top-level priority', () => {
    expect(
      validate({
        ...PLAN_TEMPLATE_WITH_SCHEMA,
        planSteps: [{ type: 'click', description: 'x' }],
      }),
    ).toBe(false);
    expect(validate({ ...PLAN_TEMPLATE_WITH_SCHEMA, priority: 'p9' })).toBe(false);
  });

  it('rejects a whitespace-only projectId/name (pattern requires a non-whitespace character)', () => {
    expect(validate({ ...PLAN_TEMPLATE_WITH_SCHEMA, projectId: '   ' })).toBe(false);
    expect(validate({ ...PLAN_TEMPLATE_WITH_SCHEMA, name: '   ' })).toBe(false);
  });

  it('allows unknown extra top-level properties (matches assertPlanShape, which has no additionalProperties check)', () => {
    expect(validate({ ...PLAN_TEMPLATE_WITH_SCHEMA, someFutureField: 'anything' })).toBe(true);
  });
});
