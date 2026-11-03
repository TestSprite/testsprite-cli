/**
 * Unit tests for src/lib/validate.ts — internal validation helpers.
 *
 * Coverage targets:
 *   - requireString: happy path, missing field, wrong type, empty string
 *   - requireEnum: happy path, missing / wrong value, accepted list in envelope
 *   - requireArrayLength: happy path, non-array, below min, above max
 *   - kind discriminator: 'flag' renders `Flag \`--field\`` in nextAction;
 *     'field' renders `Field \`field\`` in nextAction
 *   - Envelope snapshot tests: full VALIDATION_ERROR envelope byte-for-byte per
 *     helper per violation type, guarding against silent regressions
 *   - allowEmpty / minLength precedence documented + tested
 */
import { describe, expect, it } from 'vitest';
import { requireArrayLength, requireEnum, requireString } from './validate.js';

// ---------------------------------------------------------------------------
// helpers — extract the VALIDATION_ERROR envelope from a thrown ApiError
// ---------------------------------------------------------------------------

function thrownFrom(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

// Narrow to an object with the fields we care about.
function asValidationError(err: unknown): {
  code: string;
  nextAction: string;
  details: Record<string, unknown>;
  message: string;
} {
  if (
    err === null ||
    typeof err !== 'object' ||
    !('code' in err) ||
    !('nextAction' in err) ||
    !('details' in err) ||
    !('message' in err)
  ) {
    throw new TypeError(`Expected ApiError-shaped object, got: ${String(err)}`);
  }
  return err as {
    code: string;
    nextAction: string;
    details: Record<string, unknown>;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// requireString
// ---------------------------------------------------------------------------

describe('requireString', () => {
  it('happy path: valid non-empty string does not throw', () => {
    expect(() => requireString('name', 'hello')).not.toThrow();
  });

  it('happy path: allowEmpty accepts zero-length string', () => {
    expect(() => requireString('name', '', { allowEmpty: true })).not.toThrow();
  });

  it('missing field (undefined) throws VALIDATION_ERROR with correct field', () => {
    const err = asValidationError(thrownFrom(() => requireString('projectId', undefined)));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'projectId' });
  });

  it('wrong type (number) throws VALIDATION_ERROR with correct field', () => {
    const err = asValidationError(thrownFrom(() => requireString('name', 42)));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'name' });
  });

  it('empty string (allowEmpty: false default) throws VALIDATION_ERROR', () => {
    const err = asValidationError(thrownFrom(() => requireString('name', '')));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'name' });
  });

  it('kind: field renders Field in nextAction', () => {
    const err = asValidationError(thrownFrom(() => requireString('planSteps[0].description', '')));
    expect(err.nextAction).toMatch(/Field `planSteps\[0\]\.description`/);
  });

  it('kind: flag renders Flag with kebab-case in nextAction', () => {
    const err = asValidationError(
      thrownFrom(() => requireString('codeFile', '', { kind: 'flag' })),
    );
    expect(err.nextAction).toMatch(/Flag `--code-file`/);
  });

  // --- Envelope snapshot tests ---

  it('envelope snapshot: missing value (undefined), kind=field', () => {
    const err = asValidationError(thrownFrom(() => requireString('projectId', undefined)));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid request.');
    expect(err.nextAction).toBe(
      'Field `projectId` is invalid: is required and must be a non-empty string.',
    );
    expect(err.details).toEqual({
      field: 'projectId',
      reason: 'is required and must be a non-empty string',
    });
  });

  it('envelope snapshot: empty string (default allowEmpty=false), kind=field', () => {
    const err = asValidationError(thrownFrom(() => requireString('name', '')));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid request.');
    expect(err.nextAction).toBe(
      'Field `name` is invalid: is required and must be a non-empty string.',
    );
    expect(err.details).toEqual({
      field: 'name',
      reason: 'is required and must be a non-empty string',
    });
  });

  it('envelope snapshot: string too long (maxLength), kind=field', () => {
    const err = asValidationError(
      thrownFrom(() => requireString('title', 'a'.repeat(101), { maxLength: 100 })),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid request.');
    expect(err.nextAction).toBe('Field `title` is invalid: must be at most 100 characters.');
    expect(err.details).toEqual({ field: 'title', reason: 'must be at most 100 characters' });
  });

  it('envelope snapshot: missing value, kind=flag', () => {
    const err = asValidationError(
      thrownFrom(() => requireString('codeFile', undefined, { kind: 'flag' })),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid request.');
    expect(err.nextAction).toBe(
      'Flag `--code-file` is invalid: is required and must be a non-empty string.',
    );
    expect(err.details).toEqual({
      field: 'codeFile',
      reason: 'is required and must be a non-empty string',
    });
  });

  // --- allowEmpty / minLength precedence tests ---

  it('allowEmpty: true overrides minLength: 5 — zero-length string accepted', () => {
    expect(() => requireString('tag', '', { allowEmpty: true, minLength: 5 })).not.toThrow();
  });

  it('allowEmpty: false (default), minLength: 3 — string shorter than 3 rejected', () => {
    const err = asValidationError(thrownFrom(() => requireString('tag', 'ab', { minLength: 3 })));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.nextAction).toContain('is required and must be a non-empty string');
  });
});

// ---------------------------------------------------------------------------
// requireEnum
// ---------------------------------------------------------------------------

describe('requireEnum', () => {
  const accepted = ['action', 'assertion'] as const;

  it('happy path: accepted value does not throw', () => {
    expect(() => requireEnum('type', 'action', accepted)).not.toThrow();
    expect(() => requireEnum('type', 'assertion', accepted)).not.toThrow();
  });

  it('wrong value throws VALIDATION_ERROR with correct field', () => {
    const err = asValidationError(thrownFrom(() => requireEnum('type', 'observe', accepted)));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'type' });
  });

  it('accepted list is included in the error envelope', () => {
    const err = asValidationError(thrownFrom(() => requireEnum('type', 'observe', accepted)));
    expect(err.details).toMatchObject({
      accepted: expect.arrayContaining(['action', 'assertion']),
    });
  });

  it('undefined / missing value throws VALIDATION_ERROR', () => {
    const err = asValidationError(thrownFrom(() => requireEnum('type', undefined, accepted)));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'type' });
  });

  it('kind: field renders Field in nextAction', () => {
    const err = asValidationError(
      thrownFrom(() => requireEnum('planSteps[0].type', 'bad', accepted)),
    );
    expect(err.nextAction).toMatch(/Field `planSteps\[0\]\.type`/);
  });

  it('kind: flag renders Flag with kebab-case in nextAction', () => {
    const err = asValidationError(
      thrownFrom(() => requireEnum('testType', 'bad', accepted, { kind: 'flag' })),
    );
    expect(err.nextAction).toMatch(/Flag `--test-type`/);
  });

  // --- Envelope snapshot tests ---

  it('envelope snapshot: wrong value, 2-item enum, kind=field', () => {
    const err = asValidationError(thrownFrom(() => requireEnum('type', 'observe', accepted)));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid request.');
    expect(err.nextAction).toBe('Field `type` is invalid: must be one of: "action", "assertion".');
    expect(err.details).toEqual({
      field: 'type',
      reason: 'must be one of: "action", "assertion"',
      accepted: ['action', 'assertion'],
    });
  });

  it('envelope snapshot: undefined value, 2-item enum, kind=field', () => {
    const err = asValidationError(thrownFrom(() => requireEnum('type', undefined, accepted)));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.nextAction).toBe('Field `type` is invalid: must be one of: "action", "assertion".');
    expect(err.details).toEqual({
      field: 'type',
      reason: 'must be one of: "action", "assertion"',
      accepted: ['action', 'assertion'],
    });
  });

  it('envelope snapshot: wrong value, 3-item enum, kind=field', () => {
    const priorities = ['low', 'medium', 'high'] as const;
    const err = asValidationError(thrownFrom(() => requireEnum('priority', 'urgent', priorities)));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.nextAction).toBe(
      'Field `priority` is invalid: must be one of: "low", "medium", "high".',
    );
    expect(err.details).toEqual({
      field: 'priority',
      reason: 'must be one of: "low", "medium", "high"',
      accepted: ['low', 'medium', 'high'],
    });
  });

  it('envelope snapshot: wrong value, kind=flag', () => {
    const err = asValidationError(
      thrownFrom(() =>
        requireEnum('testType', 'unknown', ['frontend', 'backend'] as const, { kind: 'flag' }),
      ),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.nextAction).toBe(
      'Flag `--test-type` is invalid: must be one of: "frontend", "backend".',
    );
    expect(err.details).toEqual({
      field: 'testType',
      reason: 'must be one of: "frontend", "backend"',
      accepted: ['frontend', 'backend'],
    });
  });
});

// ---------------------------------------------------------------------------
// requireArrayLength
// ---------------------------------------------------------------------------

describe('requireArrayLength', () => {
  it('happy path: array within bounds does not throw', () => {
    expect(() =>
      requireArrayLength('planSteps', [{ a: 1 }, { a: 2 }], { min: 1, max: 5 }),
    ).not.toThrow();
  });

  it('happy path: array at exact min does not throw', () => {
    expect(() => requireArrayLength('planSteps', [1], { min: 1 })).not.toThrow();
  });

  it('happy path: array at exact max does not throw', () => {
    expect(() => requireArrayLength('planSteps', [1, 2, 3], { max: 3 })).not.toThrow();
  });

  it('non-array throws VALIDATION_ERROR with correct field', () => {
    const err = asValidationError(
      thrownFrom(() => requireArrayLength('planSteps', 'not-an-array', { min: 1 })),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'planSteps' });
  });

  it('null throws VALIDATION_ERROR', () => {
    const err = asValidationError(
      thrownFrom(() => requireArrayLength('planSteps', null, { min: 1 })),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'planSteps' });
  });

  it('array below min throws VALIDATION_ERROR', () => {
    const err = asValidationError(
      thrownFrom(() => requireArrayLength('planSteps', [], { min: 1, itemNoun: 'step' })),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'planSteps' });
  });

  it('array above max throws VALIDATION_ERROR', () => {
    const oversize = Array.from({ length: 201 }, (_, i) => i);
    const err = asValidationError(
      thrownFrom(() =>
        requireArrayLength('planSteps', oversize, { min: 1, max: 200, itemNoun: 'step' }),
      ),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'planSteps' });
  });

  it('itemNoun: "step" uses singular in min-1 message and plural in max message', () => {
    const minErr = asValidationError(
      thrownFrom(() => requireArrayLength('planSteps', [], { min: 1, itemNoun: 'step' })),
    );
    expect(minErr.nextAction).toMatch(/at least one step/);

    const maxErr = asValidationError(
      thrownFrom(() =>
        requireArrayLength('planSteps', Array.from({ length: 5 }), {
          min: 1,
          max: 3,
          itemNoun: 'step',
        }),
      ),
    );
    expect(maxErr.nextAction).toMatch(/at most 3 steps/);
  });

  it('kind: field renders Field in nextAction', () => {
    const err = asValidationError(
      thrownFrom(() => requireArrayLength('planSteps', [], { min: 1 })),
    );
    expect(err.nextAction).toMatch(/Field `planSteps`/);
  });

  it('kind: flag renders Flag with kebab-case in nextAction', () => {
    const err = asValidationError(
      thrownFrom(() => requireArrayLength('pageSize', [], { min: 1, kind: 'flag' })),
    );
    expect(err.nextAction).toMatch(/Flag `--page-size`/);
  });

  // --- Envelope snapshot tests ---

  it('envelope snapshot: non-array value, kind=field', () => {
    const err = asValidationError(
      thrownFrom(() => requireArrayLength('planSteps', 'bad', { min: 1, itemNoun: 'step' })),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid request.');
    expect(err.nextAction).toBe('Field `planSteps` is invalid: is required and must be an array.');
    expect(err.details).toEqual({ field: 'planSteps', reason: 'is required and must be an array' });
  });

  it('envelope snapshot: below min (min=1, singular itemNoun), kind=field', () => {
    const err = asValidationError(
      thrownFrom(() => requireArrayLength('planSteps', [], { min: 1, itemNoun: 'step' })),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid request.');
    expect(err.nextAction).toBe('Field `planSteps` is invalid: must contain at least one step.');
    expect(err.details).toEqual({ field: 'planSteps', reason: 'must contain at least one step' });
  });

  it('envelope snapshot: below min (min=2, plural itemNoun), kind=field', () => {
    const err = asValidationError(
      thrownFrom(() => requireArrayLength('planSteps', [1], { min: 2, itemNoun: 'step' })),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.nextAction).toBe('Field `planSteps` is invalid: must contain at least 2 steps.');
    expect(err.details).toEqual({ field: 'planSteps', reason: 'must contain at least 2 steps' });
  });

  it('envelope snapshot: above max, kind=field', () => {
    const oversize = Array.from({ length: 5 }, (_, i) => i);
    const err = asValidationError(
      thrownFrom(() =>
        requireArrayLength('planSteps', oversize, { min: 1, max: 3, itemNoun: 'step' }),
      ),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid request.');
    expect(err.nextAction).toBe(
      'Field `planSteps` is invalid: must contain at most 3 steps (got 5).',
    );
    expect(err.details).toEqual({
      field: 'planSteps',
      reason: 'must contain at most 3 steps (got 5)',
    });
  });

  it('envelope snapshot: non-array, kind=flag', () => {
    const err = asValidationError(
      thrownFrom(() => requireArrayLength('pageItems', null, { min: 1, kind: 'flag' })),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.nextAction).toBe(
      'Flag `--page-items` is invalid: is required and must be an array.',
    );
    expect(err.details).toEqual({ field: 'pageItems', reason: 'is required and must be an array' });
  });
});
