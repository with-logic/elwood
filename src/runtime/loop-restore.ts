/** Restores persisted loop definitions before live resources start (PRD §5.9/§9.3). */

import { elwoodError } from "../core/errors.ts";
import {
  type PersistedLoopDefinition,
  pruneExpiredLoopDefinitions,
  readLoopDefinitions,
  writeLoopDefinitions,
} from "../state/loop-store.ts";

type LoopRestoreIo = {
  readonly read: typeof readLoopDefinitions;
  readonly write: typeof writeLoopDefinitions;
};

const defaultIo: LoopRestoreIo = {
  read: readLoopDefinitions,
  write: writeLoopDefinitions,
};

/** Read definitions and durably prune expiry before a resumed PTY or bridge is created. */
export function loadRuntimeLoopDefinitions(
  stateDir: string,
  elwoodSessionId: string,
  now = Date.now(),
  io: LoopRestoreIo = defaultIo,
): readonly PersistedLoopDefinition[] {
  const definitions = io.read(stateDir, elwoodSessionId);
  const active = pruneExpiredLoopDefinitions(definitions, now);
  if (active.length === definitions.length) return definitions;
  try {
    io.write(stateDir, elwoodSessionId, active);
  } catch {
    const removed = definitions.find((definition) => definition.expiresAt <= now);
    throw elwoodError("loop_persistence_failed", "Could not prune expired loop state.", {
      loopId: (removed as PersistedLoopDefinition).id,
    });
  }
  return active;
}
