/**
 * Private atomic persistence for recurring-loop definitions beside session.json.
 * Implements PRD §8.2 and C-LOOP-11/C-LOOP-13/C-LOOP-21.
 */

import { join } from "node:path";
import { elwoodError } from "../core/errors.ts";
import type { LoopDefinition } from "../core/loops/scheduler-state.ts";
import { safeSessionDir, writePrivateFileAtomic } from "./files.ts";
import { currentFileOwner, readPrivateFile } from "./private-read.ts";
import { LOOP_SIDECAR_SCHEMA_VERSION, validateLoopSidecar } from "./validate-loops.ts";

export type PersistedLoopDefinition = LoopDefinition;

const LOOP_SIDECAR_NAME = "loops.json";

/** Read and validate a session's sidecar. Absence is the canonical empty state. */
export function readLoopDefinitions(
  stateDir: string,
  elwoodSessionId: string,
): readonly PersistedLoopDefinition[] {
  const corrupt = () => corruptState(elwoodSessionId);
  let text: string | undefined;
  try {
    text = readPrivateFile(sidecarPath(stateDir, elwoodSessionId), currentFileOwner(), corrupt);
  } catch {
    throw corrupt(); // an invalid session id or an unsafe/unreadable sidecar
  }
  if (text === undefined) return [];
  try {
    const definitions = validateLoopSidecar(JSON.parse(text));
    if (definitions === null) throw corrupt();
    return definitions;
  } catch {
    throw corrupt();
  }
}

/** Atomically replace the sidecar with fresh, canonical, private definitions. */
export function writeLoopDefinitions(
  stateDir: string,
  elwoodSessionId: string,
  definitions: readonly PersistedLoopDefinition[],
): void {
  const canonical = validateLoopSidecar({
    schemaVersion: LOOP_SIDECAR_SCHEMA_VERSION,
    loops: definitions,
  });
  if (canonical === null) throw new TypeError("Loop definitions are invalid.");
  const sidecar = { schemaVersion: LOOP_SIDECAR_SCHEMA_VERSION, loops: canonical };
  writePrivateFileAtomic(
    sidecarPath(stateDir, elwoodSessionId),
    `${JSON.stringify(sidecar, null, 2)}\n`,
  );
}

/** Remove definitions expired at or before `now`, without mutating the input. */
export function pruneExpiredLoopDefinitions(
  definitions: readonly PersistedLoopDefinition[],
  now: number,
): readonly PersistedLoopDefinition[] {
  return definitions.filter((definition) => definition.expiresAt > now);
}

function sidecarPath(stateDir: string, elwoodSessionId: string): string {
  return join(safeSessionDir(stateDir, elwoodSessionId), LOOP_SIDECAR_NAME);
}

function corruptState(elwoodSessionId: string): Error {
  return elwoodError("state_corrupt", `Loop state is corrupt for ${elwoodSessionId}`);
}
