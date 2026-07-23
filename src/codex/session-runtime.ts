/**
 * Runtime file + exit-boundary helpers for Codex sessions.
 * Implements PRD §7A, §8.2, and §5.3 (C-LIFE-10).
 */

import { bridgeScriptSource } from "../bridge/script.ts";
import { finishSessionExit } from "../runtime/session-exit.ts";
import { writePrivateFileAtomic } from "../state/files.ts";
import type { SessionRuntime } from "../state/runtime-paths.ts";

export function writeCodexRuntimeFiles(runtime: SessionRuntime): void {
  writePrivateFileAtomic(
    runtime.bridgeScriptPath,
    bridgeScriptSource(runtime.socketPath, runtime.bridgeToken),
  );
}

/**
 * Run the Codex PTY-exit drain + emission behind the shared error boundary, then
 * ALWAYS submit terminal status (PRD §5.3 C-LIFE-10). `submitExit` reaps in its own
 * `finally`, so a throwing transcript finish, terminal:exit, or activity listener can
 * never skip the terminal status or the unconditional reap. Thin adapter wrapper over
 * `finishSessionExit` — kept so the Codex startup path names its own exit step.
 */
export function finishCodexExit(drainAndEmit: () => void, submitExit: () => void): void {
  finishSessionExit(drainAndEmit, submitExit);
}
