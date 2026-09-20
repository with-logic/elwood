/**
 * Unit tests for the evidence-driven session status engine.
 * Covers PRD §5.3 and §9 lifecycle guarantees (C-PTY-06, C-LIFE-02).
 */

import { describe, expect, test } from "vitest";
import type { ElwoodSessionStatus } from "../../src/core/types.ts";
import { decideStatus, type StatusEvidenceKind } from "../../src/runtime/status-evidence.ts";

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

  test.each([
    "initial_ready",
    "hook_turn_ended",
    "rendered_turn_ended",
    "caller_submitted",
    "rendered_turn_started",
  ] as const)("C-ATTN-02 %s must not reopen a blocked session", (evidence) => {
    // Late readiness and turn evidence must preserve a visible blocking prompt.
    // Only `blocking_prompt_cleared` can return the session to ready.
    const decision = decideStatus("blocked", evidence);
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

test.each([
  "initial_ready",
  "hook_turn_ended",
  "rendered_turn_ended",
  "blocking_prompt_cleared",
] as const)("C-TRUST-01 %s cannot release a trust-held input gate", (evidence) => {
  expect(decideStatus("blocked", evidence, true).to).toBeUndefined();
  expect(decideStatus("running", evidence, true).to).toBeUndefined();
});
