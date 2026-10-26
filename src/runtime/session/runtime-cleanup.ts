/**
 * Session runtime cleanup, shared by the Claude and Codex adapters (PRD §9.4,
 * C-LIFE-12): stop the hook bridge, finish the transcript watcher, then drain and
 * dispose the terminal, in that order. It runs on every shutdown and on an unsolicited
 * exit, including a shutdown whose PTY could not be terminated, so the watcher stops
 * polling even while the PTY lives on.
 */

import type { PtyProcess } from "../../pty/types.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { runCleanupSteps } from "../shutdown/teardown.ts";
import { drainAndDisposeTerminal } from "../shutdown/terminal.ts";

/** What a session's runtime cleanup stops beyond its terminal. */
export type SessionRuntimeParts = {
  readonly stopBridge: () => Promise<void>;
  /** One bounded final flush of what the transcript already holds, then no more polling. */
  readonly finishTranscriptWatcher: () => Promise<void> | void;
};

/** Every step runs even if an earlier one rejects, so nothing is left running (§9.4). */
export function stopSessionRuntime(
  parts: SessionRuntimeParts,
  terminal: ElwoodTerminal,
  pty: Pick<PtyProcess, "onData">,
): Promise<void> {
  return runCleanupSteps([
    () => parts.stopBridge(),
    () => parts.finishTranscriptWatcher(),
    () => drainAndDisposeTerminal(terminal, pty),
  ]);
}
