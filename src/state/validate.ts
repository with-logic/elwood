/**
 * Runtime validation for persisted Elwood session records.
 * Implements PRD §8.2 and §10.
 */

import { isAbsolute, join, resolve } from "node:path";
import { allStatuses, type ElwoodSessionStatus } from "../core/status-categories.ts";
import type { TerminalSize } from "../core/types.ts";
import { safeSessionDir } from "./files.ts";
import type { SessionRecord } from "./store.ts";
import { isLaunchPosture } from "./validate-posture.ts";
import { isRecord, isString } from "./validate-predicates.ts";
import { isWarningArray } from "./validate-warnings.ts";

export function validateSessionRecord(
  value: unknown,
  stateDir: string,
  id: string,
): SessionRecord | null {
  if (!isRecord(value)) return null;
  const adapter = value["adapter"];
  if (value["schemaVersion"] !== 1 || value["elwoodSessionId"] !== id) return null;
  if (adapter !== "claude" && adapter !== "codex") return null;
  if (!isString(value["bridgeToken"])) return null;
  if (!(isString(value["cwd"]) && isRecord(value["metadata"]))) return null;
  if (!(isString(value["createdAt"]) && isString(value["updatedAt"]))) return null;
  if (!(isStatus(value["status"]) && isWarningArray(value["warnings"]))) return null;
  if (!(isAdapterState(value["claude"], "claude") && isAdapterState(value["codex"], "codex")))
    return null;
  if (!isTerminalSize(value["terminalSize"])) return null;
  if (!hasExpectedPaths(value["paths"], stateDir, id, adapter)) return null;
  return value as SessionRecord;
}

function hasExpectedPaths(
  value: unknown,
  stateDir: string,
  id: string,
  adapter: "claude" | "codex",
): boolean {
  if (!isRecord(value)) return false;
  const dir = safeSessionDir(resolve(stateDir), id);
  return (
    value["sessionDir"] === dir &&
    value["settingsPath"] === join(dir, `${adapter}-settings.json`) &&
    value["bridgeScriptPath"] === join(dir, "hook-bridge.mjs") &&
    // The socket home is regenerated on every launch before use, so a stored
    // socket path only needs to be a plausible absolute path (PRD §8.1).
    isString(value["socketPath"]) &&
    isAbsolute(value["socketPath"] as string)
  );
}

// C-STATE-13: a persisted launch posture must round-trip; unknown shapes and
// out-of-union policy values invalidate the record rather than resuming with a
// corrupted policy. Each adapter's posture is validated against its own union
// via isLaunchPosture in validate-posture.ts.
function isAdapterState(value: unknown, adapter: "claude" | "codex"): boolean {
  if (!isRecord(value)) return false;
  if (!(optionalString(value["resumeId"]) && optionalString(value["name"]))) return false;
  return isLaunchPosture(value["launch"], adapter);
}

function isTerminalSize(value: unknown): value is TerminalSize | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Number.isInteger(value["cols"]) && Number.isInteger(value["rows"]);
}

function isStatus(value: unknown): value is ElwoodSessionStatus {
  return typeof value === "string" && allStatuses.has(value as ElwoodSessionStatus);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
