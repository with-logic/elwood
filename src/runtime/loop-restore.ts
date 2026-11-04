/** Restores persisted loop definitions before live resources start (PRD §5.9/§9.3, C-API-20). */

import { elwoodError } from "../core/errors.ts";
import type { LaunchOwnership, StateFileWriter } from "../state/launch-ownership.ts";
import {
  type PersistedLoopDefinition,
  pruneExpiredLoopDefinitions,
  readLoopSidecar,
  writeLoopDefinitions,
} from "../state/loop-store.ts";

/** Parse and prune one fresh owned snapshot; the paired writer keeps its rollback preimage. */
export function loadRuntimeLoopDefinitions(
  stateDir: string,
  elwoodSessionId: string,
  access: { readonly readFile: LaunchOwnership["readFile"]; readonly writeFile: StateFileWriter },
  now = Date.now(),
  read = readLoopSidecar,
): readonly PersistedLoopDefinition[] {
  const { definitions } = read(stateDir, elwoodSessionId, access.readFile);
  const expired = definitions.find((definition) => definition.expiresAt <= now);
  if (expired === undefined) return definitions;
  const active = pruneExpiredLoopDefinitions(definitions, now);
  try {
    writeLoopDefinitions(stateDir, elwoodSessionId, active, access.writeFile);
  } catch {
    // Details name only the loop id, never its prompt (§10 loop_persistence_failed).
    throw elwoodError("loop_persistence_failed", "Could not prune expired loop state.", {
      loopId: expired.id,
    });
  }
  return active;
}
