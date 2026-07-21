/**
 * Codex session runtime cleanup helpers.
 * Implements PRD §9.3.
 */

import { runCleanupSteps } from "../runtime/teardown.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import type { CodexTranscriptWatcher } from "./transcript.ts";

type CodexRuntimeBridge = {
  readonly stop: () => Promise<void>;
};

export function stopCodexRuntime(
  bridge: CodexRuntimeBridge,
  transcriptWatcher: CodexTranscriptWatcher | undefined,
  terminal: ElwoodTerminal,
): Promise<void> {
  // Every step runs even if an earlier one throws, so a failing bridge stop still
  // finishes the transcript watcher and disposes the terminal (no leak; PRD §9.4).
  return runCleanupSteps([
    () => bridge.stop(),
    () => transcriptWatcher?.finish(),
    () => terminal.dispose(),
  ]);
}
