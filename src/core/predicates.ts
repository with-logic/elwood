/**
 * Shared runtime shape predicates for values crossing a trust boundary: hook
 * payloads (PRD §6.4, §7A.3), persisted records (§8.2), and CLI config (§12A.4).
 * Every adapter and store validates value TYPES, not merely key names, and they
 * all do it with these primitives.
 */

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

export function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/**
 * A JSON-representable number. `NaN` and `±Infinity` are `typeof "number"` but
 * `JSON.stringify` emits them as `null`, so accepting them here would let a hook
 * rewrite send a null where the CLI's schema requires a number (PRD §6.4).
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Absent, or a finite number. Named for the contract: a non-finite number FAILS. */
export function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

export { isFiniteThroughout } from "./json-shape.ts";

export function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

export function optionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

/** True when `value` is one of the allowed string literals; narrows to that union. */
export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
