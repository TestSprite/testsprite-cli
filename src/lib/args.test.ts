import { describe, expect, it } from 'vitest';
import { requireNonEmpty } from './args.js';

describe('requireNonEmpty', () => {
  it('accepts non-empty strings', () => {
    expect(() => requireNonEmpty('test-id', 'test_123')).not.toThrow();
  });

  it('rejects undefined', () => {
    expect(() => requireNonEmpty('test-id', undefined)).toThrowError();
  });

  it('rejects empty string with VALIDATION_ERROR and exit 5', () => {
    try {
      requireNonEmpty('test-id', '');
      expect.unreachable();
    } catch (err: unknown) {
      expect(err).toMatchObject({
        code: 'VALIDATION_ERROR',
        exitCode: 5,
        details: { field: 'test-id', reason: 'is required' },
      });
    }
  });

  it('rejects whitespace-only string', () => {
    try {
      requireNonEmpty('<project-id>', '   ');
      expect.unreachable();
    } catch (err: unknown) {
      expect(err).toMatchObject({
        code: 'VALIDATION_ERROR',
        exitCode: 5,
        details: { field: 'project-id', reason: 'is required' },
      });
    }
  });
});
