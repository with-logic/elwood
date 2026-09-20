/** Hook bookkeeping continues after notification failures (PRD §6.4, C-HOOK-22). */
import { expect, test, vi } from "vitest";
import { buildClaudeHookHandler } from "../../src/claude/session/hook-handler.ts";
import { TurnStateWatcher } from "../../src/core/turn-state.ts";
import type { ClaudeEventMap } from "../../src/core/types.ts";
import { TypedEmitter } from "../../src/events/emitter.ts";
import { initialReady } from "../../src/runtime/readiness/initial-ready.ts";
import { createSessionRecord } from "../../src/state/store.ts";

test.each([
  "transcript_observation",
  "transcript_scan",
  "readiness",
] as const)("C-HOOK-22 %s failure cannot abort the captured response or later bookkeeping", async (failure) => {
  const emitter = new TypedEmitter<ClaudeEventMap>();
  if (failure === "transcript_observation")
    emitter.on("hook:Stop", () => ({ decision: "block", reason: "retained decision" }));
  const warnings: unknown[] = [];
  emitter.on("warning", (event) => warnings.push(event));
  const turn = new TurnStateWatcher();
  const arm = vi.spyOn(turn, "arm");
  const scan = vi.fn(() => {
    if (failure === "transcript_scan") throw new Error("private transcript");
  });
  const ready = initialReady(() => {
    throw new Error("private lifecycle");
  });
  const handler = buildClaudeHookHandler({
    record: createSessionRecord({ id: "session", cwd: "/tmp" }),
    options: { cwd: "/tmp" },
    emitter,
    ready,
    transcriptWatcher: { scan },
    getSession: () => undefined,
    getTurnWatcher: () => turn,
    observeHookTranscript: () => {
      if (failure === "transcript_observation") throw new Error("private transcript");
    },
  });
  const result = await handler({
    hook_event_name: failure === "readiness" ? "InstructionsLoaded" : "Stop",
    session_id: "claude-1",
    cwd: "/tmp",
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
  });
  expect(result).toEqual({
    exitCode: 0,
    stdout:
      failure === "transcript_observation"
        ? '{"decision":"block","reason":"retained decision"}\n'
        : "",
    stderr: "",
  });
  if (failure === "transcript_scan") {
    expect(scan).toHaveBeenCalledOnce();
    expect(arm).toHaveBeenCalledOnce();
  } else {
    expect(scan).not.toHaveBeenCalled();
    expect(arm).not.toHaveBeenCalled();
  }
  expect(warnings).toEqual([
    expect.objectContaining({
      code: "hook_observer_failed",
      phase: failure === "readiness" ? "lifecycle" : "transcript",
    }),
  ]);
  expect(JSON.stringify(warnings)).not.toContain("private");
});
