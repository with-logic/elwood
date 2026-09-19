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

/** Shape limits complement the hook payload byte ceiling (PRD §6.4, C-HOOK-18). */
const maxTraversalVisits = 100_000;
const maxTraversalDepth = 128;

/**
 * Reject non-finite numbers, ancestor cycles, and over-limit shapes.
 * Each occurrence counts toward the visit budget, including primitives and shared
 * children. Only ancestors are tracked: sharing is valid, but ancestor cycles are not.
 */
export function isFiniteThroughout(value: unknown): boolean {
  const ancestors = new WeakSet<object>();
  let visited = 0;

  function visit(current: unknown, depth: number): boolean {
    // Bound recursion before descending, including into primitive leaves.
    if (++visited > maxTraversalVisits || depth > maxTraversalDepth) return false;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current !== "object" || current === null) return true;
    if (ancestors.has(current)) return false;
    ancestors.add(current);
    const children: readonly unknown[] = Array.isArray(current) ? current : Object.values(current);
    // Iterate instead of spreading children into a call: wide arrays/records can
    // exceed JavaScript's argument limit long before the traversal budget is checked.
    for (const child of children) {
      if (!visit(child, depth + 1)) return false;
    }
    ancestors.delete(current);
    return true;
  }

  return visit(value, 0);
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
