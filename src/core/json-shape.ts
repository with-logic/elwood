/** Bounded JSON-compatible hook values without executing accessors/serializers (PRD §6.4, C-HOOK-18). */
const maxTraversalVisits = 100_000;
const maxTraversalDepth = 128;

/** Sharing is valid; ancestor cycles and values JSON cannot safely encode are not. */
export function isFiniteThroughout(value: unknown): boolean {
  try {
    return new ValueTraversal().visit(value, 0);
  } catch {
    // Hostile proxy traps fail validation rather than escaping into hook dispatch.
    return false;
  }
}

class ValueTraversal {
  private readonly ancestors = new WeakSet<object>();
  private visited = 0;

  visit(current: unknown, depth: number): boolean {
    if (++this.visited > maxTraversalVisits || depth > maxTraversalDepth) return false;
    if (typeof current === "number") return Number.isFinite(current);
    if (current === null || current === undefined) return true;
    if (typeof current !== "object")
      return typeof current === "string" || typeof current === "boolean";
    const prototype: unknown = Object.getPrototypeOf(current);
    if (
      prototype !== null &&
      prototype !== (Array.isArray(current) ? Array.prototype : Object.prototype)
    )
      return false;
    if ("toJSON" in current || this.ancestors.has(current)) return false;
    this.ancestors.add(current);
    const valid = this.children(current, depth);
    this.ancestors.delete(current);
    return valid;
  }

  private children(current: object, depth: number): boolean {
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1)
        if (!this.child(current, String(index), depth)) return false;
    } else {
      for (const key in current)
        if (Object.hasOwn(current, key) && !this.child(current, key, depth)) return false;
    }
    return true;
  }

  private child(current: object, key: string, depth: number): boolean {
    if (this.visited >= maxTraversalVisits) return false;
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    // Accessors can change between validation and serialization; never invoke them.
    return (
      descriptor !== undefined && "value" in descriptor && this.visit(descriptor.value, depth + 1)
    );
  }
}
