/**
 * Claude session runtime cleanup (PRD §9.4, C-LIFE-12): the shared runtime cleanup over
 * Claude's hook bridge and transcript watcher.
 */

import type { PtyProcess } from "../../pty/types.ts";
import { stopSessionRuntime } from "../../runtime/session/runtime-cleanup.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";

export type HookBridge = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

/** The runtime a Claude session owns beyond its PTY and terminal. */
export type ClaudeRuntimeParts = {
  readonly bridge: HookBridge;
  /** Flushes the transcript watcher behind its error boundary, then stops it for good. */
  readonly finishTranscriptWatcher: () => void;
};

export function stopClaudeRuntime(
  parts: ClaudeRuntimeParts,
  terminal: ElwoodTerminal,
  pty: Pick<PtyProcess, "onData">,
): Promise<void> {
  const { bridge, finishTranscriptWatcher } = parts;
  return stopSessionRuntime(
    { stopBridge: () => bridge.stop(), finishTranscriptWatcher },
    terminal,
    pty,
  );
}
