/**
 * Codex session runtime cleanup (PRD §9.4, C-LIFE-12): the shared runtime cleanup over
 * Codex's hook bridge and transcript watcher.
 */

import type { PtyProcess } from "../../pty/types.ts";
import { stopSessionRuntime } from "../../runtime/session/runtime-cleanup.ts";
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
  const parts = {
    stopBridge: () => bridge.stop(),
    finishTranscriptWatcher: () => transcriptWatcher?.finish(),
  };
  return stopSessionRuntime(parts, terminal, pty);
}
