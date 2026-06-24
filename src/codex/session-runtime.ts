/**
 * Runtime file helpers for Codex sessions.
 * Implements PRD §7A and §8.2.
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
