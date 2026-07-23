/**
 * Runtime validation for persisted Elwood session records.
 * Implements PRD §8.2 and §10: the persisted record carries only the minimal fields
 * resume needs. An unknown adapter, a mismatched id, or a corrupted launch posture
 * invalidates the record rather than resuming with corrupted state.
 */

import type { SessionRecord } from "./store.ts";
import { isLaunchPosture } from "./validate-posture.ts";
import { isRecord, isString } from "./validate-predicates.ts";

export function validateSessionRecord(value: unknown, id: string): SessionRecord | null {
  if (!isRecord(value)) return null;
  const adapter = value["adapter"];
  if (value["schemaVersion"] !== 1 || value["elwoodSessionId"] !== id) return null;
  if (adapter !== "claude" && adapter !== "codex") return null;
  if (!isString(value["cwd"])) return null;
  if (!(isAdapterState(value["claude"], "claude") && isAdapterState(value["codex"], "codex")))
    return null;
  return value as SessionRecord;
}

// C-STATE-13: a persisted launch posture must round-trip; unknown shapes and
// out-of-union policy values invalidate the record rather than resuming with a
// corrupted policy. Each adapter's posture is validated against its own union
// via isLaunchPosture in validate-posture.ts.
function isAdapterState(value: unknown, adapter: "claude" | "codex"): boolean {
  if (!isRecord(value)) return false;
  if (!optionalString(value["resumeId"])) return false;
  return isLaunchPosture(value["launch"], adapter);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
