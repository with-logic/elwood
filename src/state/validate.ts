/**
 * Runtime validation for persisted Elwood session records.
 * Implements PRD §8.2 and §10.
 */

import { join, resolve } from "node:path";
import type { ElwoodSessionStatus, ElwoodWarningEvent, TerminalSize } from "../core/types.ts";
import { safeSessionDir } from "./files.ts";
import type { SessionRecord } from "./store.ts";

const statuses = new Set<ElwoodSessionStatus>([
  "starting",
  "running",
  "ready",
  "stopped",
  "exited",
  "killed",
  "torn_down",
]);

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
    value["socketPath"] === join(dir, "hook.sock")
  );
}

function isAdapterState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return optionalString(value["resumeId"]) && optionalString(value["name"]);
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
  return false;
}

function isStatus(value: unknown): value is ElwoodSessionStatus {
  return typeof value === "string" && statuses.has(value as ElwoodSessionStatus);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
