/**
 * Runtime validation for persisted Elwood session records.
 * Implements PRD §8.2 and §10.
 */

import { isAbsolute, join, resolve } from "node:path";
import { allStatuses, type ElwoodSessionStatus } from "../core/status-categories.ts";
import type { ElwoodWarningEvent, TerminalSize } from "../core/types.ts";
import { safeSessionDir } from "./files.ts";
import type { SessionRecord } from "./store.ts";

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
  if (!(isAdapterState(value["claude"]) && isAdapterState(value["codex"]))) return null;
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

function isAdapterState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!(optionalString(value["resumeId"]) && optionalString(value["name"]))) return false;
  return isLaunchPosture(value["launch"]);
}

// C-STATE-13: a persisted launch posture must round-trip; unknown shapes
// invalidate the record rather than resuming with corrupted policy.
function isLaunchPosture(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    optionalString(value["permissionMode"]) &&
    optionalString(value["sandbox"]) &&
    optionalString(value["approvalPolicy"]) &&
    optionalStringArray(value["allowedTools"]) &&
    optionalStringArray(value["disallowedTools"]) &&
    optionalStringArray(value["tools"])
  );
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isTerminalSize(value: unknown): value is TerminalSize | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Number.isInteger(value["cols"]) && Number.isInteger(value["rows"]);
}

function isWarningArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isWarning);
}

function isWarning(value: unknown): value is ElwoodWarningEvent {
  if (!isRecord(value)) return false;
  if (value["severity"] !== "warning") return false;
  if (value["code"] === "version_unparseable") {
    return (
      (value["agent"] === "claude" || value["agent"] === "codex") &&
      value["source"] === "lifecycle" &&
      isString(value["elwoodSessionId"]) &&
      isString(value["message"]) &&
      isString(value["raw"])
    );
  }
  if (value["code"] === "mcp_server_not_logged_in") {
    return (
      value["agent"] === "codex" &&
      value["source"] === "terminal" &&
      isString(value["elwoodSessionId"]) &&
      isString(value["message"]) &&
      isString(value["mcpServerName"]) &&
      isString(value["recoveryCommand"]) &&
      isString(value["raw"])
    );
  }
  if (value["code"] === "mcp_startup_incomplete") {
    return (
      value["agent"] === "codex" &&
      value["source"] === "terminal" &&
      isString(value["elwoodSessionId"]) &&
      isString(value["message"]) &&
      isStringArray(value["failedServers"]) &&
      isStringArray(value["recoveryCommands"]) &&
      isString(value["raw"])
    );
  }
  if (value["code"] === "codex_default_model_persisted") {
    return (
      value["agent"] === "codex" &&
      value["source"] === "lifecycle" &&
      isString(value["elwoodSessionId"]) &&
      isString(value["message"]) &&
      isString(value["raw"])
    );
  }
  if (value["code"] === "transcript_records_dropped") {
    return (
      value["agent"] === "claude" &&
      value["source"] === "terminal" &&
      isString(value["elwoodSessionId"]) &&
      isString(value["message"]) &&
      isNumber(value["droppedCount"]) &&
      isNumber(value["droppedBytes"]) &&
      isString(value["transcriptPath"]) &&
      isString(value["raw"])
    );
  }
  if (value["code"] === "transcript_read_error") {
    return (
      value["agent"] === "claude" &&
      value["source"] === "terminal" &&
      isString(value["elwoodSessionId"]) &&
      isString(value["message"]) &&
      isNumber(value["errorCount"]) &&
      isString(value["lastErrorCode"]) &&
      isString(value["transcriptPath"]) &&
      isString(value["raw"])
    );
  }
  return false;
}

function isStatus(value: unknown): value is ElwoodSessionStatus {
  return typeof value === "string" && allStatuses.has(value as ElwoodSessionStatus);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
