/** Shared bounded JSON validation and detached snapshots (PRD §6.4, C-HOOK-18/21). */
import { types } from "node:util";

const invalid = Symbol("invalid JSON data");
const maxDepth = 128;
const maxVisits = 100_000;
export type JsonSnapshot =
  | { readonly valid: true; readonly value: unknown }
  | { readonly valid: false };

export function snapshotJsonData(value: unknown): JsonSnapshot {
  const snapshot = new JsonDataWalker(true).visit(value, 0);
  return snapshot === invalid ? { valid: false } : { valid: true, value: snapshot };
}

/** Apply the same descriptors and budgets without constructing a detached graph. */
export function validateJsonData(value: unknown): boolean {
  return new JsonDataWalker(false).visit(value, 0) !== invalid;
}

class JsonDataWalker {
  private readonly ancestors = new WeakSet<object>();
  private readonly copy: boolean;
  private visits = 0;

  constructor(copy: boolean) {
    this.copy = copy;
  }

  visit(value: unknown, depth: number): unknown {
    this.visits += 1;
    if (depth > maxDepth) return invalid;
    if (value === undefined || value === null) return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : invalid;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value !== "object" || types.isProxy(value) || types.isBoxedPrimitive(value))
      return invalid;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      prototype !== null &&
      prototype !== (Array.isArray(value) ? Array.prototype : Object.prototype)
    )
      return invalid;
    const serializer = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (
      serializer &&
      (!Object.hasOwn(serializer, "value") || typeof serializer.value === "function")
    )
      return invalid;
    if (this.ancestors.has(value)) return invalid;
    this.ancestors.add(value);
    const result = this.children(value, depth);
    this.ancestors.delete(value);
    return result;
  }

  private children(value: object, depth: number): unknown {
    if (Array.isArray(value)) {
      const result: unknown[] | undefined = this.copy ? [] : undefined;
      for (let i = 0; i < value.length; i += 1) {
        const child = this.child(value, String(i), depth);
        if (child === invalid) return invalid;
        result?.push(child);
      }
      // Preserve Array methods used by validators while shadowing inherited serializers.
      return result === undefined
        ? value
        : Object.defineProperty(result, "toJSON", { value: undefined });
    }
    const result: Record<string, unknown> | undefined = this.copy ? Object.create(null) : undefined;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const child = this.child(value, key, depth);
      if (child === invalid) return invalid;
      if (result !== undefined) result[key] = child;
    }
    return result ?? value;
  }

  private child(value: object, key: string, depth: number): unknown {
    if (this.visits >= maxVisits) return invalid;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // Missing array indices become undefined, which JSON encodes as null.
    if (descriptor === undefined) return this.visit(undefined, depth + 1);
    return Object.hasOwn(descriptor, "value") ? this.visit(descriptor.value, depth + 1) : invalid;
  }
}
