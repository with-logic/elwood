/**
 * Focused unit coverage for the typed event emitter: delivery, error
 * isolation, and unsubscribe semantics (PRD §5.4, §8).
 */

import { describe, expect, test } from "vitest";
import type { ElwoodEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";

describe("TypedEmitter", () => {
  test("C-API-08 event emitter handles empty emissions and explicit off", async () => {
    const emitter = new TypedEmitter<ElwoodEventMap>();
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
    const emitter = new TypedEmitter<ElwoodEventMap>();
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
    const emitter = new TypedEmitter<ElwoodEventMap>();
    const seen: string[] = [];
    const b = (event: { readonly status: string }) => seen.push(`b:${event.status}`);
    // Listener A unsubscribes B mid-emit; B must NOT fire afterwards even though
    // it was in the snapshot when the emission began (README unsubscribe contract).
    emitter.on("status", () => emitter.off("status", b));
    emitter.on("status", b);
    emitter.emit("status", { elwoodSessionId: "x", status: "ready" });
    expect(seen).toEqual([]);
  });

  test("a listener added mid-emit does not fire during the emission in progress", () => {
    const emitter = new TypedEmitter<ElwoodEventMap>();
    const seen: string[] = [];
    const late = (event: { readonly status: string }) => seen.push(`late:${event.status}`);
    // The copy-on-write `list` snapshot is frozen when the emission begins, so a
    // listener the first handler adds only participates in the NEXT emission.
    emitter.on("status", () => emitter.on("status", late));
    emitter.emit("status", { elwoodSessionId: "x", status: "running" });
    expect(seen).toEqual([]);
    emitter.emit("status", { elwoodSessionId: "x", status: "ready" });
    expect(seen).toEqual(["late:ready"]);
  });

  test("registering the same handler twice is a no-op: it fires once and one off removes it", () => {
    const emitter = new TypedEmitter<ElwoodEventMap>();
    let calls = 0;
    const handler = () => {
      calls += 1;
    };
    emitter.on("status", handler);
    emitter.on("status", handler); // duplicate registration is ignored
    emitter.emit("status", { elwoodSessionId: "x", status: "ready" });
    expect(calls).toBe(1);
    emitter.off("status", handler);
    emitter.emit("status", { elwoodSessionId: "x", status: "ready" });
    expect(calls).toBe(1);
    // A second off for an already-removed handler is a harmless no-op.
    emitter.off("status", handler);
  });

  test("request skips a handler unsubscribed by an earlier request handler", async () => {
    const emitter = new TypedEmitter<ElwoodEventMap>();
    const b = () => "b-result";
    // The first async handler removes B before B is reached; the immutable `list`
    // snapshot still contains B, so `request` must consult `live` and skip it.
    emitter.on("status", () => {
      emitter.off("status", b);
      return undefined;
    });
    emitter.on("status", b);
    expect(
      await emitter.request("status", { elwoodSessionId: "x", status: "ready" }),
    ).toBeUndefined();
  });
});
