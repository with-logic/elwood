/**
 * Runtime validation for persisted Elwood session records.
 * Implements PRD §8.2 and §10: the persisted record carries only the minimal fields
 * resume needs. An unknown adapter, a mismatched id, or a corrupted launch posture
 * invalidates the record rather than resuming with corrupted state.
 */

import type { AdapterState, ClaudeLaunchPosture, CodexLaunchPosture } from "./launch-posture.ts";
import type { SessionRecord } from "./store.ts";
import { isLaunchPosture } from "./validate-posture.ts";
import { isRecord, isString } from "./validate-predicates.ts";

/**
 * Validates a persisted record and returns a FRESH canonical `SessionRecord` built
 * from ONLY the allowlisted validated fields — never the untrusted object itself.
 * A legacy record carrying now-removed fields (a stale bridge token, socket/runtime
 * paths, persisted warnings, metadata, terminal size) is therefore stripped on the
 * next write, so a former IPC credential can never round-trip back onto disk (§8.2).
 */
export function validateSessionRecord(value: unknown, id: string): SessionRecord | null {
  if (!isRecord(value)) return null;
  const adapter = value["adapter"];
  if (value["schemaVersion"] !== 1 || value["elwoodSessionId"] !== id) return null;
  if (adapter !== "claude" && adapter !== "codex") return null;
  if (!isString(value["cwd"])) return null;
  const claude = adapterState<ClaudeLaunchPosture>(value["claude"], "claude");
  const codex = adapterState<CodexLaunchPosture>(value["codex"], "codex");
  if (claude === null || codex === null) return null;
  return { schemaVersion: 1, elwoodSessionId: id, adapter, cwd: value["cwd"], claude, codex };
}

// C-STATE-13: a persisted launch posture must round-trip; unknown shapes and
// out-of-union policy values invalidate the record rather than resuming with a
// corrupted policy. Each adapter's posture is validated against its own union via
// isLaunchPosture. Returns a FRESH adapter-state carrying ONLY resumeId + launch —
// any legacy extras (e.g. a persisted `name`) are dropped, not carried forward.
function adapterState<P>(value: unknown, adapter: "claude" | "codex"): AdapterState<P> | null {
  if (!isRecord(value)) return null;
  const resumeId = value["resumeId"];
  if (!optionalString(resumeId)) return null;
  if (!isLaunchPosture(value["launch"], adapter)) return null;
  return {
    ...(resumeId === undefined ? {} : { resumeId }),
    ...(value["launch"] === undefined ? {} : { launch: value["launch"] as P }),
  };
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}
