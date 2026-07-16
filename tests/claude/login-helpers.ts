/**
 * Shared fixtures for the ClaudeSession.login conformance suites (C-API-43).
 * Provides readiness bootstrap plus a helper that drives a FRESH `ready`
 * transition — the signal `login()` now waits for after "Login successful."
 * before it resolves (a success banner alone no longer proves usability).
 */

import type { ClaudeSession } from "../../src/index.ts";
import { ptys } from "./helpers.ts";

export const ESC = String.fromCharCode(27);
export const ARROW_DOWN = `${ESC}[B`;
/** Renders the working-turn token so turn-state detects a started turn. */
export const WORKING_FOOTER = "❯ \r\n  ⏵⏵ bypass permissions · esc to interrupt · ← for agents";

export const instructionsLoaded = (cwd: string) => ({
  hook_event_name: "InstructionsLoaded",
  session_id: "claude-1",
  cwd,
  file_path: "/tmp/CLAUDE.md",
  memory_type: "Project",
  load_reason: "session_start",
});

export const stopHook = (cwd: string) => ({
  hook_event_name: "Stop",
  session_id: "claude-1",
  cwd,
  stop_hook_active: false,
});

/** Reach initial readiness via the InstructionsLoaded hook. */
export async function ready(cwd: string, session: ClaudeSession): Promise<void> {
  await ptys[0]!.dispatchHook(session.elwoodSessionId, instructionsLoaded(cwd));
}

/**
 * Emit the fresh running→ready transition `login()`'s `awaitUsable` waits for: a
 * working footer reaches `running`, then a Stop hook ends the turn to `ready`.
 * The footer is re-emitted each tick until `running` is observed — the fake
 * terminal coalesces same-tick frames, so a single emit can be dropped when it
 * races an adjacent frame (e.g. the success banner emitted just before). Does NOT
 * wait for the final `ready` itself (a queued follow-up op can immediately flip
 * the session back to `running`); callers synchronize on the `login()` promise.
 */
export async function driveFreshReady(cwd: string, session: ClaudeSession): Promise<void> {
  while (session.status !== "running") {
    ptys[0]!.emitData(WORKING_FOOTER);
    await new Promise((r) => setTimeout(r, 20));
  }
  await ptys[0]!.dispatchHook(session.elwoodSessionId, stopHook(cwd));
}
