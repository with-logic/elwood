/**
 * Unit tests for SessionStatusEngine apply/queue ordering and telemetry isolation
 * (PRD §5.3, §9): a throwing status listener must never wedge the control queue.
 */

import { describe, expect, test } from "vitest";
import {
  maxStatusDecisions,
  SessionStatusEngine,
  type StatusEngineIo,
} from "../../src/runtime/status-evidence.ts";

function recordingIo(calls: string[]): StatusEngineIo {
  return {
    onReady: () => calls.push("onReady"),
    emitStatus: (status) => calls.push(`status:${status}`),
    queueRunning: () => calls.push("queueRunning"),
    queueReady: () => calls.push("queueReady"),
    queueBlocked: () => calls.push("queueBlocked"),
    queueClose: () => calls.push("queueClose"),
    cleanup: () => calls.push("cleanup"),
  };
}

describe("SessionStatusEngine", () => {
  test("C-LIFE-02 applies running, ready, and exited with queue ordering", () => {
    const calls: string[] = [];
    const engine = new SessionStatusEngine(recordingIo(calls));
    expect(engine.status).toBe("starting");
    engine.submit("startup_usable");
    engine.submit("initial_ready");
    engine.submit("terminal_exited");
    expect(engine.status).toBe("exited");
    // running: commit BEFORE queueRunning; ready: onReady + emit before queueReady so
    // drained sends observe the new status. Status is live-only (no persist).
    expect(calls.join(",")).toBe(
      "queueRunning,status:running,onReady,status:ready," +
        "queueReady,queueClose,status:exited,cleanup",
    );
  });

  test("C-LIFE-02 stop closes the queue without runtime cleanup", () => {
    const calls: string[] = [];
    const engine = new SessionStatusEngine(recordingIo(calls));
    engine.submit("startup_usable");
    calls.length = 0;
    const decision = engine.submit("stop_completed");
    expect(decision.to).toBe("stopped");
    expect(calls).toEqual(["queueClose", "status:stopped"]);
  });

  test("C-ATTN-02 blocked can follow ready, settles to ready, and yields to terminal", () => {
    const calls: string[] = [];
    const engine = new SessionStatusEngine(recordingIo(calls));
    engine.submit("startup_usable");
    engine.submit("initial_ready");
    calls.length = 0;
    // The dialog can appear after the working indicator has already cleared.
    expect(engine.submit("blocking_prompt_shown").to).toBe("blocked");
    // Blocked suspends the queue (no send may write into the dialog), not closes it.
    expect(calls).toEqual(["queueBlocked", "status:blocked"]);
    // Resolving the dialog settles to ready (the composer is waiting again).
    expect(engine.submit("blocking_prompt_cleared").to).toBe("ready");
    // A stale clear with no active block is ignored.
    expect(engine.submit("blocking_prompt_cleared").to).toBeUndefined();
    engine.submit("terminal_exited"); // blocking evidence never revives a terminal session
    expect(engine.submit("blocking_prompt_shown").to).toBeUndefined();
  });

  test("C-API-19 a throwing status listener on a READY transition STILL reopens the queue", () => {
    // Telemetry must never wedge the queue: on rendered_turn_ended / blocking_prompt_
    // cleared / initial_ready (all → ready), a throwing status listener must NOT skip
    // queueReady() — else the queue stays suspended while `current` is already ready,
    // so later ready evidence is a no-op and queued work starves. queueReady() runs in
    // a `finally`, so it is guaranteed even when emitStatus throws.
    for (const kind of ["rendered_turn_ended", "blocking_prompt_cleared"] as const) {
      const calls: string[] = [];
      let armed = false; // throw ONLY on the tested ready transition, not during setup
      const io = recordingIo(calls);
      const throwingIo: StatusEngineIo = {
        ...io,
        emitStatus: (s) => {
          calls.push(`status:${s}`);
          if (armed) throw new Error("status listener boom");
        },
      };
      const engine = new SessionStatusEngine(throwingIo);
      engine.submit("startup_usable");
      engine.submit("initial_ready");
      if (kind === "rendered_turn_ended")
        engine.submit("caller_submitted"); // → running
      else engine.submit("blocking_prompt_shown"); // → blocked
      calls.length = 0;
      armed = true;
      // The ready transition's listener throws — but the queue is still reopened.
      expect(() => engine.submit(kind)).toThrow(/status listener boom/);
      expect(calls).toContain("queueReady"); // reopen guaranteed despite the throw
    }
  });

  test("ignored evidence is logged but applies nothing", () => {
    const calls: string[] = [];
    const engine = new SessionStatusEngine(recordingIo(calls));
    engine.submit("teardown_completed");
    calls.length = 0;
    const decision = engine.submit("rendered_turn_started");
    expect(decision.to).toBeUndefined();
    expect(calls).toEqual([]);
    expect(engine.status).toBe("torn_down");
    expect(engine.decisions().at(-1)).toBe(decision);
  });

  test("decision log stays bounded at the most recent entries", () => {
    const engine = new SessionStatusEngine(recordingIo([]));
    engine.submit("startup_usable");
    // Each rendered_turn_started from `running` is a no-op (already running),
    // so it is logged as ignored without changing status.
    for (let i = 0; i < maxStatusDecisions + 5; i += 1) engine.submit("rendered_turn_started");
    expect(engine.decisions()).toHaveLength(maxStatusDecisions);
    // The `startup_usable` applied entry has been evicted; the retained tail
    // is all ignored no-ops.
    expect(engine.decisions().every((decision) => decision.to === undefined)).toBe(true);
    expect(engine.status).toBe("running");
  });
});
