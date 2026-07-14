/**
 * Focused unit coverage for the typed event emitter: delivery, error
 * isolation, and unsubscribe semantics (PRD §5.4, §8).
 */

import { describe, expect, test } from "vitest";
import { TypedEmitter } from "../../src/events/emitter.ts";

describe("TypedEmitter", () => {
  test("C-API-08 event emitter handles empty emissions and explicit off", async () => {
    const emitter = new TypedEmitter();
    emitter.emit("status", { elwoodSessionId: "x", status: "running" });
    expect(
      await emitter.request("status", { elwoodSessionId: "x", status: "running" }),
    ).toBeUndefined();
    const statuses: string[] = [];
    const handler = (event: { readonly status: string }) => statuses.push(event.status);
    const unsubscribe = emitter.on("status", handler);
    emitter.emit("status", { elwoodSessionId: "x", status: "running" });
    emitter.off("status", handler);
    unsubscribe();
    emitter.emit("status", { elwoodSessionId: "x", status: "ready" });
    const offUndefinedHandler = emitter.on("status", () => undefined);
    expect(
      await emitter.request("status", { elwoodSessionId: "x", status: "ready" }),
    ).toBeUndefined();
    offUndefinedHandler();
    emitter.listen("status", (event) => event.status);
    expect(await emitter.request("status", { elwoodSessionId: "x", status: "ready" })).toBe(
      "ready",
    );
    expect(statuses).toEqual(["running"]);
  });

  test("emit delivers to every listener before rethrowing the first failure", () => {
    const emitter = new TypedEmitter();
    const seen: string[] = [];
    // A rogue user listener throwing must not abort delivery to the internal
    // lifecycle subscriber registered after it (e.g. interrupt/compact settle);
    // the failure is still surfaced to any enclosing boundary via a rethrow.
    emitter.on("status", () => {
      throw new Error("first rogue");
    });
    emitter.on("status", (event) => seen.push(event.status));
    emitter.on("status", () => {
      throw new Error("second rogue");
    });
    expect(() => emitter.emit("status", { elwoodSessionId: "x", status: "ready" })).toThrow(
      "first rogue",
    );
    // Every listener ran despite the earlier throw.
    expect(seen).toEqual(["ready"]);
  });

  test("emit honors an unsubscribe made by an earlier listener in the same emission", () => {
    const emitter = new TypedEmitter();
    const seen: string[] = [];
    const b = (event: { readonly status: string }) => seen.push(`b:${event.status}`);
    // Listener A unsubscribes B mid-emit; B must NOT fire afterwards even though
    // it was in the snapshot when the emission began (README unsubscribe contract).
    emitter.on("status", () => emitter.off("status", b));
    emitter.on("status", b);
    emitter.emit("status", { elwoodSessionId: "x", status: "ready" });
    expect(seen).toEqual([]);
  });
});
