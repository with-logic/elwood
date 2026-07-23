/**
 * Shared field-shape predicates for Claude hook payload validation.
 * Implements PRD §6.4: value TYPES, not merely key names, are validated.
 */

export type FieldCheck = (value: unknown) => boolean;

/**
 * A validator table COUPLED to a public tool input `T`: exactly one field check per
 * key of `T` (required, so adding a field to the public type forces a matching check
 * and can't silently pass validation). Declare each table `satisfies FieldChecks<T>`.
 */
export type FieldChecks<T> = { readonly [K in keyof Required<T>]-?: FieldCheck };

/**
 * Validates a partial record: every present key must be one of `checks` and its
 * value must pass that field's check. Absent keys pass (partial rewrites and
 * optional fields), unknown keys fail.
 */
export function partial(
  value: Readonly<Record<string, unknown>>,
  checks: Readonly<Record<string, FieldCheck>>,
): boolean {
  return Object.keys(value).every(
    (key) => Object.hasOwn(checks, key) && (checks[key] as FieldCheck)(value[key]),
  );
}

export function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

export function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

export function optionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
