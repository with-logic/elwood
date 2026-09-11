/**
 * Writes the per-session runtime files (the hook bridge script) for Codex sessions.
 * Implements PRD §7A and §8.2.
 */

import { bridgeScriptSource } from "../../bridge/script.ts";
import { writePrivateFileAtomic } from "../../state/files.ts";
import type { SessionRuntime } from "../../state/runtime-paths.ts";

export function writeCodexRuntimeFiles(runtime: SessionRuntime): void {
  writePrivateFileAtomic(
    runtime.bridgeScriptPath,
    bridgeScriptSource(runtime.socketPath, runtime.bridgeToken),
  );
}
