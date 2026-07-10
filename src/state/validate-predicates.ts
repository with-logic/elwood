/**
 * Shared low-level predicates for persisted session-record validation.
 * Implements PRD §8.2 and §10 (used by validate.ts and validate-warnings.ts).
 */

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString);
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** A persisted byte total: a non-negative safe integer (never fractional/negative). */
export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A persisted event count: a POSITIVE safe integer (a notice always counts ≥ 1). */
export function isPositiveCount(value: unknown): value is number {
  return isCount(value) && value > 0;
}
