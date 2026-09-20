/** Detached, bounded JSON data for hook response validation and serialization (PRD §6.4, C-HOOK-21). */
import { types } from "node:util";

const invalid = Symbol("invalid JSON data");
const maxDepth = 128;
const maxVisits = 100_000;
export type JsonSnapshot =
  | { readonly valid: true; readonly value: unknown }
  | { readonly valid: false };

export function snapshotJsonData(value: unknown): JsonSnapshot {
  const snapshot = new Snapshot().visit(value, 0);
  return snapshot === invalid ? { valid: false } : { valid: true, value: snapshot };
}

class Snapshot {
  private readonly ancestors = new WeakSet<object>();
  private visits = 0;

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
    if (serializer && (!("value" in serializer) || typeof serializer.value === "function"))
      return invalid;
    if (this.ancestors.has(value)) return invalid;
    this.ancestors.add(value);
    const result = this.children(value, depth);
    this.ancestors.delete(value);
    return result;
  }

  private children(value: object, depth: number): unknown {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let i = 0; i < value.length; i += 1) {
        const child = this.child(value, String(i), depth);
        if (child === invalid) return invalid;
        result.push(child);
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const child = this.child(value, key, depth);
      if (child === invalid) return invalid;
      result[key] = child;
    }
    return result;
  }

  private child(value: object, key: string, depth: number): unknown {
    if (this.visits >= maxVisits) return invalid;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // Missing array indices become undefined, which JSON encodes as null.
    if (descriptor === undefined) return this.visit(undefined, depth + 1);
    return "value" in descriptor ? this.visit(descriptor.value, depth + 1) : invalid;
  }
}
