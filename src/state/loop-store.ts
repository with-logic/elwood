/**
 * Private atomic persistence for recurring-loop definitions beside session.json.
 * Implements PRD §8.2 and C-LOOP-11/C-LOOP-13/C-LOOP-21.
 */

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { elwoodError, errnoCode } from "../core/errors.ts";
import type { LoopDefinition } from "../core/loops/scheduler-state.ts";
import { safeSessionDir, writePrivateFileAtomic } from "./files.ts";
import { LOOP_SIDECAR_SCHEMA_VERSION, validateLoopSidecar } from "./validate-loops.ts";

export type PersistedLoopDefinition = LoopDefinition;

const LOOP_SIDECAR_NAME = "loops.json";

/** Read and validate a session's sidecar. Absence is the canonical empty state. */
export function readLoopDefinitions(
  stateDir: string,
  elwoodSessionId: string,
): readonly PersistedLoopDefinition[] {
  const path = sidecarPath(stateDir, elwoodSessionId);
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw corruptState(elwoodSessionId);
  }
  const expectedUid = process.getuid?.();
  if (
    !metadata.isFile() ||
    expectedUid === undefined ||
    metadata.uid !== expectedUid ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw corruptState(elwoodSessionId);
  }
  try {
    const definitions = validateLoopSidecar(JSON.parse(readFileSync(path, "utf8")));
    if (definitions === null) throw corruptState(elwoodSessionId);
    return definitions;
  } catch {
    throw corruptState(elwoodSessionId);
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
