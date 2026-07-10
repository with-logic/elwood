/**
 * Runtime file + exit-boundary helpers for Codex sessions.
 * Implements PRD §7A, §8.2, and §5.3 (C-LIFE-10).
 */

import { bridgeScriptSource } from "../bridge/script.ts";
import { writePrivateFileAtomic } from "../state/files.ts";
import type { SessionRecord } from "../state/store.ts";

export function writeCodexRuntimeFiles(record: SessionRecord): void {
  writePrivateFileAtomic(
    record.paths.bridgeScriptPath,
    bridgeScriptSource(record.paths.socketPath, record.bridgeToken),
  );
}

/**
 * Run the Codex PTY-exit drain + emission behind an error boundary, then ALWAYS
 * submit terminal status (PRD §5.3 C-LIFE-10). `submitExit` reaps the descendant
 * tree in its own `finally`, so a throwing transcript finish, terminal:exit, or
 * activity listener can never skip the terminal status or the unconditional reap,
 * and no listener failure escapes the native exit callback.
 */
export function finishCodexExit(drainAndEmit: () => void, submitExit: () => void): void {
  try {
    drainAndEmit();
  } catch {
    // A throwing drain/emit listener must not skip terminal status + reap.
  } finally {
    try {
      submitExit();
    } catch {
      // Status submitted and reap ran in submitExit's finally; contain the rest.
    }
  }
}
