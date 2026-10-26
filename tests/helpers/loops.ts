/** A session's loop definitions, read and validated as Elwood reads them (PRD §8.2). */

import { type PersistedLoopDefinition, readLoopSidecar } from "../../src/state/loop-store.ts";

/** Reads `elwoodSessionId`'s sidecar; absence is the empty list. */
export function readLoopDefinitions(
  stateDir: string,
  elwoodSessionId: string,
): readonly PersistedLoopDefinition[] {
  return readLoopSidecar(stateDir, elwoodSessionId).definitions;
}
