import { localValidationError } from './errors.js';

/**
 * Validates that an identifier or required positional parameter is a non-empty,
 * non-whitespace string. Throws `VALIDATION_ERROR` (exit 5) before client creation.
 */
export function requireNonEmpty(name: string, value: string | undefined): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    const field = name.replace(/^<|>$/g, '');
    throw localValidationError(field, 'is required');
  }
}
