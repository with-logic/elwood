/**
 * Runtime validation for persisted typed warning events.
 * Implements PRD §5.7, §8.2, and §10: every persisted warning is a named variant
 * carrying only bounded diagnostics; an unknown or malformed shape invalidates
 * the record rather than resuming with a corrupted snapshot.
 */

import type { ElwoodWarningEvent } from "../core/types.ts";
import {
  isCount,
  isPositiveCount,
  isRecord,
  isString,
  isStringArray,
} from "./validate-predicates.ts";

export function isWarningArray(value: unknown): boolean {
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
      claudeTerminalBase(value) &&
      isPositiveCount(value["droppedCount"]) &&
      isCount(value["droppedBytes"]) &&
      isString(value["transcriptPath"])
    );
  }
  if (value["code"] === "transcript_read_error") {
    return (
      claudeTerminalBase(value) &&
      isPositiveCount(value["errorCount"]) &&
      isString(value["lastErrorCode"]) &&
      isString(value["transcriptPath"])
    );
  }
  if (value["code"] === "transcript_poll_stopped") {
    return claudeTerminalBase(value) && isString(value["reason"]);
  }
  if (value["code"] === "reap_failed") {
    // Content-free lifecycle diagnostic: the leaked group's pgid + a normalized
    // error code, per agent, never a raw system message (§5.7, C-LIFE-10).
    return (
      (value["agent"] === "claude" || value["agent"] === "codex") &&
      value["source"] === "lifecycle" &&
      isString(value["elwoodSessionId"]) &&
      isString(value["message"]) &&
      Number.isInteger(value["processGroupId"]) &&
      isString(value["errorCode"]) &&
      isString(value["raw"])
    );
  }
  return false;
}

/** Fields common to every claude-agent terminal warning: agent/source/session/message/raw. */
function claudeTerminalBase(value: Readonly<Record<string, unknown>>): boolean {
  return value["agent"] === "claude" && terminalBase(value);
}

/** The source/session/message/raw fields common to all terminal warnings. */
function terminalBase(value: Readonly<Record<string, unknown>>): boolean {
  return (
    value["source"] === "terminal" &&
    isString(value["elwoodSessionId"]) &&
    isString(value["message"]) &&
    isString(value["raw"])
  );
}
