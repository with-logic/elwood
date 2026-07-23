/**
 * Shared low-level predicates for persisted session-record validation.
 * Implements PRD §8.2 and §10 (used by validate.ts and validate-posture.ts).
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
