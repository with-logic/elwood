/** Restores persisted loop definitions before live resources start (PRD §5.9/§9.3, C-API-20). */

import { elwoodError } from "../core/errors.ts";
import type { StateFileWriter } from "../state/launch-ownership.ts";
import {
  type PersistedLoopDefinition,
  pruneExpiredLoopDefinitions,
  readLoopSidecar,
  writeLoopDefinitions,
} from "../state/loop-store.ts";

/**
 * Read definitions and durably prune expiry before a resumed PTY or bridge is created. The prune
 * goes through the launch's `write`, with the text it was read from, so a launch that then fails
 * restores the sidecar it found (C-API-20, C-LOOP-13).
 */
export function loadRuntimeLoopDefinitions(
  stateDir: string,
  elwoodSessionId: string,
  write: StateFileWriter,
  now = Date.now(),
  read = readLoopSidecar,
): readonly PersistedLoopDefinition[] {
  const { definitions, text } = read(stateDir, elwoodSessionId);
  const expired = definitions.find((definition) => definition.expiresAt <= now);
  if (expired === undefined) return definitions;
  const active = pruneExpiredLoopDefinitions(definitions, now);
  try {
    writeLoopDefinitions(stateDir, elwoodSessionId, active, (path, next) =>
      write(path, next, text),
    );
  } catch {
    // Details name only the loop id, never its prompt (§10 loop_persistence_failed).
    throw elwoodError("loop_persistence_failed", "Could not prune expired loop state.", {
      loopId: expired.id,
    });
  }
  return active;
}
