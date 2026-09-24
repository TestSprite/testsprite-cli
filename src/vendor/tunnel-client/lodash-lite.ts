/**
 * VENDOR DELTA (not upstream). Upstream's `client.ts` pulls `isNumber`,
 * `isPlainObject` and `isString` from `lodash`; this CLI ships three runtime
 * dependencies on purpose, and these three predicates are a handful of lines.
 *
 * Semantics match lodash's for every value this code path can see (JSON
 * parsed off the wire): `isNumber` accepts the `number` primitive — lodash
 * also accepts `Number` objects and `NaN`, neither of which `JSON.parse`
 * ever produces — and `isPlainObject` accepts an object literal or a
 * null-prototype object, rejecting arrays and `null`.
 */

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === null || proto === Object.prototype;
}
