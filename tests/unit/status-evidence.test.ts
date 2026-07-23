/**
 * Unit tests for the evidence-driven session status engine.
 * Covers PRD §5.3 and §9 lifecycle guarantees (C-PTY-06, C-LIFE-02).
 */

import { describe, expect, test } from "vitest";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";
import {
  decideStatus,
  maxStatusDecisions,
  SessionStatusEngine,
  type StatusEngineIo,
  type StatusEvidenceKind,
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

// Exhaustive map: adding a StatusEvidenceKind without a target fails to
// compile, so the union and the engine stay in lockstep.
const evidenceTargets = {
  startup_usable: "running",
  initial_ready: "ready",
  hook_turn_ended: "ready",
  rendered_turn_started: "running",
  rendered_turn_ended: "ready",
  caller_submitted: "running",
  blocking_prompt_shown: "blocked",
  blocking_prompt_cleared: "ready",
  terminal_exited: "exited",
  stop_completed: "stopped",
  kill_completed: "killed",
  teardown_completed: "torn_down",
} satisfies Record<StatusEvidenceKind, ElwoodSessionStatus>;

/** Turn/blocking evidence that only applies once the session is live. */
const requiresLiveSession = new Set<StatusEvidenceKind>([
  "hook_turn_ended",
  "rendered_turn_started",
  "rendered_turn_ended",
  "caller_submitted",
  "blocking_prompt_shown",
  "blocking_prompt_cleared",
]);

describe("decideStatus", () => {
  test("maps every evidence kind to its target from a valid source status", () => {
    // A source from which each evidence produces a real transition (no same-status no-op).
    const validSource: Record<StatusEvidenceKind, ElwoodSessionStatus> = {
      startup_usable: "starting",
      initial_ready: "running",
      hook_turn_ended: "running",
      rendered_turn_started: "ready",
      rendered_turn_ended: "running",
      caller_submitted: "ready",
      blocking_prompt_shown: "running",
      blocking_prompt_cleared: "blocked",
      terminal_exited: "running",
      stop_completed: "running",
      kill_completed: "running",
      teardown_completed: "running",
    };
    for (const [kind, target] of Object.entries(evidenceTargets)) {
      const evidence = kind as StatusEvidenceKind;
      const decision = decideStatus(validSource[evidence], evidence);
      expect(decision.to).toBe(target);
      expect(decision.reason).toContain("applied");
    }
  });

  test("turn/blocking evidence is ignored before the session is live", () => {
    for (const evidence of requiresLiveSession) {
      const decision = decideStatus("starting", evidence);
      expect(decision.to).toBeUndefined();
      expect(decision.reason).toContain("before the session is live");
    }
  });

  test("initial_ready may bootstrap starting to ready, but startup_usable cannot regress it", () => {
    // A hook-driven readiness can arrive before startup health resolves.
    expect(decideStatus("starting", "initial_ready").to).toBe("ready");
    // A late startup_usable then must not regress ready back to running.
    expect(decideStatus("ready", "startup_usable").to).toBeUndefined();
    // From starting, startup_usable is the normal transition to running.
    expect(decideStatus("starting", "startup_usable").to).toBe("running");
  });

  test("blocking_prompt_shown only applies from running or ready", () => {
    expect(decideStatus("running", "blocking_prompt_shown").to).toBe("blocked");
    expect(decideStatus("ready", "blocking_prompt_shown").to).toBe("blocked");
    // From `blocked` itself it is a no-op (already blocked, same target).
    expect(decideStatus("blocked", "blocking_prompt_shown").to).toBeUndefined();
  });

  test("C-API-37 initial_ready must not reopen a blocked startup session", () => {
    // A startup dialog can be on screen when readiness fires; applying `ready`
    // would drain queued input into it. Only `blocking_prompt_cleared` unblocks.
    const decision = decideStatus("blocked", "initial_ready");
    expect(decision.to).toBeUndefined();
    expect(decision.reason).toContain("reopen a blocked session");
    expect(decideStatus("blocked", "blocking_prompt_cleared").to).toBe("ready");
  });

  test("evidence whose target equals the current status is a no-op", () => {
    // `hook_turn_ended` targets `ready`; from `ready` it applies nothing.
    expect(decideStatus("ready", "hook_turn_ended").to).toBeUndefined();
  });

  test("C-PTY-06 turn evidence is ignored once the session is terminal", () => {
    for (const evidence of ["rendered_turn_started", "rendered_turn_ended"] as const) {
      const decision = decideStatus("exited", evidence);
      expect(decision.to).toBeUndefined();
      expect(decision.reason).toContain("ignored");
    }
    expect(decideStatus("killed", "stop_completed").to).toBeUndefined();
    expect(decideStatus("torn_down", "terminal_exited").to).toBeUndefined();
  });
});

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
