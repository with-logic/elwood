/**
 * Claude session runtime cleanup (PRD §9.4, C-LIFE-12): stop the hook bridge, finish the
 * transcript watcher, and drain and dispose the terminal. It runs on every shutdown and
 * on an unsolicited exit, including a `teardown()` whose PTY could not be terminated, so
 * the watcher stops polling even while the PTY lives on.
 */

import type { PtyProcess } from "../../pty/types.ts";
import { runCleanupSteps } from "../../runtime/shutdown/teardown.ts";
import { drainAndDisposeTerminal } from "../../runtime/shutdown/terminal.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";

export type HookBridge = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

/** The runtime a Claude session owns beyond its PTY and terminal. */
export type ClaudeRuntimeParts = {
  readonly bridge: HookBridge;
  /** Flushes the transcript watcher behind its error boundary, then stops it for good. */
  readonly finishTranscript: () => void;
};

/** Every step runs even if an earlier one rejects, so nothing is left running (§9.4). */
export function stopClaudeRuntime(
  parts: ClaudeRuntimeParts,
  terminal: ElwoodTerminal,
  pty: Pick<PtyProcess, "onData">,
): Promise<void> {
  return runCleanupSteps([
    () => parts.bridge.stop(),
    () => parts.finishTranscript(),
    () => drainAndDisposeTerminal(terminal, pty),
  ]);
}
