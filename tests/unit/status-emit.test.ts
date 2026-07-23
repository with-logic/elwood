/**
 * Coverage for emitStatusEvents (PRD §5.3): status and activity are delivered, and
 * a throwing listener PROPAGATES by design — the initial_ready transition relies on
 * that throw to trigger its classify-and-release fallback (C-API-42).
 */

import { describe, expect, test } from "vitest";
import type { ElwoodEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import type { SessionStatusEmitter } from "../../src/runtime/session-base-types.ts";
import { emitStatusEvents } from "../../src/runtime/status-emit.ts";

// A REAL, fully-typed emitter over the public event map — no cast. If the status or
// activity payload emitStatusEvents produces ever drifts from the ElwoodEventMap
// contract, this assignment stops compiling (that is the point of the test).
function emitterOf(): SessionStatusEmitter {
  return new TypedEmitter<ElwoodEventMap>();
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
