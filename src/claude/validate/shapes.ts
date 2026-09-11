/**
 * Field-shape validation tables for Claude hook payloads, built on the shared
 * trust-boundary predicates in core/predicates.ts.
 * Implements PRD §6.4: value TYPES, not merely key names, are validated.
 */

export {
  isRecord,
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
} from "../../core/predicates.ts";

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
