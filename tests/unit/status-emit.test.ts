/**
 * Coverage for emitStatusEvents (PRD §5.3): status and activity are delivered, and
 * a throwing listener PROPAGATES by design — the initial_ready transition relies on
 * that throw to trigger its classify-and-release fallback (C-API-42).
 */

import { describe, expect, test } from "vitest";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { emitStatusEvents } from "../../src/runtime/status-emit.ts";

type MinimalMap = {
  status: { readonly elwoodSessionId: string; readonly status: "ready" };
  activity: unknown;
};

function emitterOf() {
  return new TypedEmitter<MinimalMap>() as unknown as Parameters<typeof emitStatusEvents>[0];
}

describe("emitStatusEvents (§5.3)", () => {
  test("§5.3 delivers both status and activity to listeners", () => {
    const emitter = emitterOf();
    const seen: string[] = [];
    emitter.on("status", () => seen.push("status"));
    emitter.on("activity", () => seen.push("activity"));
    emitStatusEvents(emitter, "claude", "s1", "ready");
    expect(seen).toEqual(["status", "activity"]);
  });

  test("C-API-42 a throwing status listener propagates so the fallback can classify it", () => {
    const emitter = emitterOf();
    emitter.on("status", () => {
      throw new Error("status boom");
    });
    expect(() => emitStatusEvents(emitter, "codex", "s2", "ready")).toThrow(/status boom/);
  });
});
