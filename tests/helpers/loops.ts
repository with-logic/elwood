/** A session's loop definitions, read and validated as Elwood reads them (PRD §8.2). */

import { LOOP_EXPIRATION_MS } from "../../src/core/loops/constants.ts";
import { type PersistedLoopDefinition, readLoopSidecar } from "../../src/state/loop-store.ts";

/** Reads `elwoodSessionId`'s sidecar; absence is the empty list. */
export function readLoopDefinitions(
  stateDir: string,
  elwoodSessionId: string,
): readonly PersistedLoopDefinition[] {
  return readLoopSidecar(stateDir, elwoodSessionId).definitions;
}

/** A fixed-minute loop carrying the shared check message and a chosen expiry. */
export function fixedLoop(id: string, expiresAt: number): PersistedLoopDefinition {
  return {
    id,
    message: "check",
    mode: "fixed",
    intervalMs: 60_000,
    jitterMs: 0,
    createdAt: expiresAt - LOOP_EXPIRATION_MS,
    expiresAt,
  };
}
