/**
 * Codex session runtime cleanup helpers.
 * Implements PRD §9.3.
 */

import type { PtyProcess } from "../../pty/types.ts";
import { runCleanupSteps } from "../../runtime/shutdown/teardown.ts";
import { drainAndDisposeTerminal } from "../../runtime/shutdown/terminal.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import type { CodexTranscriptWatcher } from "../transcript/index.ts";

type CodexRuntimeBridge = {
  readonly stop: () => Promise<void>;
};

export function stopCodexRuntime(
  bridge: CodexRuntimeBridge,
  transcriptWatcher: CodexTranscriptWatcher | undefined,
  terminal: ElwoodTerminal,
  pty: Pick<PtyProcess, "onData">,
): Promise<void> {
  // Every step runs even if an earlier one throws, so a failing bridge stop still
  // finishes the transcript watcher and disposes the terminal (no leak; PRD §9.4).
  return runCleanupSteps([
    () => bridge.stop(),
    () => transcriptWatcher?.finish(),
    () => drainAndDisposeTerminal(terminal, pty),
  ]);
}
