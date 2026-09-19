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

/** Hook payloads are already capped at 8 MiB (C-HOOK-16); this bounds SHAPE, not size. */
const maxTraversalNodes = 100_000;

/**
 * True when NO number anywhere in `value` is non-finite. Schema-less tool inputs (MCP,
 * generic, and future tools) have no field table to check, so the finite rule is applied
 * structurally instead: it must hold for every tool, not only the ones Elwood types
 * concretely, or a rewrite still puts a `null` on the wire (PRD §6.4, C-HOOK-18).
 *
 * Deliberately ITERATIVE and bounded. This validator runs on values that crossed a trust
 * boundary, so a deeply nested or CYCLIC input must fail validation — a plain rejection
 * the caller sees as "invalid" — rather than overflow the stack. A `RangeError` here
 * would escape as a dispatch `handler_error`, and under a permissive CLI baseline the
 * tool could then run without the policy decision its handler was registered to make.
 */
export function isFiniteThroughout(value: unknown): boolean {
  const stack: unknown[] = [value];
  // Identity-based, so a value legitimately REPEATED (a shared child object) is visited
  // once rather than mistaken for a cycle; a true cycle terminates for the same reason.
  const seen = new WeakSet<object>();
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object" || current === null) continue;
    if (seen.has(current)) continue;
    if (++visited > maxTraversalNodes) return false; // unbounded shape: reject, never throw
    seen.add(current);
    if (Array.isArray(current)) stack.push(...current);
    else if (isRecord(current)) stack.push(...Object.values(current));
  }
  return true;
}

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
