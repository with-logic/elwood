/**
 * Status-engine wiring (PRD §5.3/§5.9, C-API-42) over a REAL typed emitter: applied
 * transitions deliver status + activity events, suspend or release the control
 * queue and loop delivery, and a throwing status listener PROPAGATES by design so
 * the initial-ready fallback can classify it.
 */

import { describe, expect, test } from "vitest";
import type { ControlQueue } from "../../src/core/control-queue/index.ts";
import type { ElwoodEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import type { SessionLoops } from "../../src/runtime/session/loops.ts";
import {
  createSessionStatusEngine,
  emitStatusEvents,
} from "../../src/runtime/session/status-wiring.ts";

function harness() {
  const calls: string[] = [];
  const emitter = new TypedEmitter<ElwoodEventMap>();
  emitter.on("status", (event) => calls.push(`status:${event.status}`));
  emitter.on("activity", (event) => calls.push(`activity:${event.kind}`));
  const queue = {
    suspendReadiness: () => calls.push("queue.suspend"),
    markReady: () => calls.push("queue.ready"),
    close: () => calls.push("queue.close"),
  } as Pick<ControlQueue, "suspendReadiness" | "markReady" | "close"> as ControlQueue;
  const loops = {
    running: () => calls.push("loops.running"),
    ready: () => calls.push("loops.ready"),
    pause: () => calls.push("loops.pause"),
  } as Pick<SessionLoops, "running" | "ready" | "pause"> as SessionLoops;
  const engine = createSessionStatusEngine({
    agent: "claude",
    elwoodSessionId: "s1",
    emitter,
    queue,
    loops,
    markReady: () => calls.push("everReady"),
    cleanup: () => calls.push("cleanup"),
  });
  return { calls, emitter, engine };
}

describe("createSessionStatusEngine", () => {
  test("§5.3 running suspends delivery and emits status then activity", () => {
    const h = harness();
    h.engine.submit("startup_usable");
    expect(h.calls).toEqual([
      "loops.running",
      "queue.suspend",
      "status:running",
      "activity:status",
    ]);
  });

  test("§5.3 ready latches everReady, emits, then releases loops and the queue", () => {
    const h = harness();
    h.engine.submit("startup_usable");
    h.calls.length = 0;
    h.engine.submit("hook_turn_ended");
    expect(h.calls).toEqual([
      "everReady",
      "status:ready",
      "activity:status",
      "loops.ready",
      "queue.ready",
    ]);
  });

  test("§5.9 a blocking dialog suspends delivery exactly like a running turn (no new turn)", () => {
    const h = harness();
    h.engine.submit("startup_usable");
    h.engine.submit("hook_turn_ended");
    h.calls.length = 0;
    h.engine.submit("blocking_prompt_shown");
    expect(h.calls).toEqual([
      "loops.running",
      "queue.suspend",
      "status:blocked",
      "activity:status",
    ]);
  });

  test("§9.4 an unsolicited exit pauses loops, closes the queue, and floats cleanup", () => {
    const h = harness();
    h.engine.submit("terminal_exited");
    expect(h.calls).toEqual([
      "loops.pause",
      "queue.close",
      "status:exited",
      "activity:status",
      "cleanup",
    ]);
  });

  test("C-API-42 a throwing status listener propagates so the fallback can classify it", () => {
    const emitter = new TypedEmitter<ElwoodEventMap>();
    emitter.on("status", () => {
      throw new Error("status boom");
    });
    expect(() => emitStatusEvents(emitter, "codex", "s2", "ready")).toThrow(/status boom/);
  });
});
