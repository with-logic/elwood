/**
 * Runtime validation for persisted typed warning events.
 * Implements PRD §5.7, §8.2, and §10: every persisted warning is a named variant
 * carrying only bounded diagnostics; an unknown or malformed shape invalidates
 * the record rather than resuming with a corrupted snapshot. The validator map is
 * keyed exhaustively by `ElwoodWarningEvent["code"]`, so adding a warning variant
 * fails to compile until it is validated here.
 */

import { isStartupPromptLabel } from "../core/startup-automation.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import {
  isDropCause,
  isPollErrorReason,
  isPollPhase,
  isReapErrorCode,
  isResizeErrorCode,
} from "../core/warning-reasons.ts";
import {
  isCount,
  isPositiveCount,
  isRecord,
  isString,
  isStringArray,
} from "./validate-predicates.ts";

type WarningFields = Readonly<Record<string, unknown>>;
type WarningValidator = (value: WarningFields) => boolean;

export function isWarningArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isWarning);
}

function isWarning(value: unknown): value is ElwoodWarningEvent {
  if (!isRecord(value)) return false;
  if (value["severity"] !== "warning") return false;
  const code = value["code"];
  if (typeof code !== "string" || !Object.hasOwn(warningValidators, code)) return false;
  return warningValidators[code as ElwoodWarningEvent["code"]](value);
}

const warningValidators = {
  version_unparseable: (value) =>
    (value["agent"] === "claude" || value["agent"] === "codex") &&
    value["source"] === "lifecycle" &&
    isString(value["elwoodSessionId"]) &&
    isString(value["message"]) &&
    isString(value["raw"]),
  mcp_server_not_logged_in: (value) =>
    value["agent"] === "codex" &&
    terminalBase(value) &&
    isString(value["mcpServerName"]) &&
    isString(value["recoveryCommand"]),
  mcp_startup_incomplete: (value) =>
    value["agent"] === "codex" &&
    terminalBase(value) &&
    isStringArray(value["failedServers"]) &&
    isStringArray(value["recoveryCommands"]),
  codex_default_model_persisted: (value) =>
    value["agent"] === "codex" &&
    value["source"] === "lifecycle" &&
    isString(value["elwoodSessionId"]) &&
    isString(value["message"]) &&
    isString(value["raw"]),
  transcript_records_dropped: (value) =>
    claudeTerminalBase(value) &&
    isPositiveCount(value["droppedCount"]) &&
    isCount(value["droppedBytes"]) &&
    isDropCause(value["cause"]) &&
    isString(value["transcriptPath"]),
  transcript_read_error: (value) =>
    claudeTerminalBase(value) &&
    isPositiveCount(value["errorCount"]) &&
    isString(value["lastErrorCode"]) &&
    isString(value["transcriptPath"]),
  // The `reason` is validated against the SAME allowlist the producer draws from,
  // so a non-allowlisted (possibly conversation-derived) reason cannot round-trip.
  transcript_poll_stopped: (value) =>
    claudeTerminalBase(value) && isPollErrorReason(value["reason"]) && isPollPhase(value["phase"]),
  // The `label` is bounded to the fixed startup-prompt label set, so a persisted
  // failure can never round-trip a raw prompt/screen string as its label (§5.4, §5.7).
  startup_prompt_write_failed: (value) =>
    (value["agent"] === "claude" || value["agent"] === "codex") &&
    terminalBase(value) &&
    isStartupPromptLabel(value["label"]),
  // Content-free lifecycle diagnostic: the leaked group's pgid (a real leader pid,
  // so a safe integer > 1) + an ALLOWLISTED normalized error code, per agent —
  // never a raw system message (§5.7, C-LIFE-10).
  reap_failed: (value) =>
    (value["agent"] === "claude" || value["agent"] === "codex") &&
    value["source"] === "lifecycle" &&
    isString(value["elwoodSessionId"]) &&
    isString(value["message"]) &&
    isProcessGroupId(value["processGroupId"]) &&
    isReapErrorCode(value["errorCode"]) &&
    isString(value["raw"]),
  // Content-free lifecycle diagnostic: the size Elwood tried to restore (positive
  // terminal dimensions) + an ALLOWLISTED normalized error code — never a raw
  // system message (§5.3, §5.7, C-API-39).
  resize_restore_failed: (value) =>
    value["agent"] === "claude" &&
    value["source"] === "lifecycle" &&
    isString(value["elwoodSessionId"]) &&
    isString(value["message"]) &&
    isPositiveCount(value["requestedCols"]) &&
    isPositiveCount(value["requestedRows"]) &&
    isResizeErrorCode(value["errorCode"]) &&
    isString(value["raw"]),
} satisfies Record<ElwoodWarningEvent["code"], WarningValidator>;

/** A persisted PTY leader process-group id: a real pid, so a safe integer > 1. */
function isProcessGroupId(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 1;
}

/** Fields common to every claude-agent terminal warning: agent/source/session/message/raw. */
function claudeTerminalBase(value: WarningFields): boolean {
  return value["agent"] === "claude" && terminalBase(value);
}

/** The source/session/message/raw fields common to all terminal warnings. */
function terminalBase(value: WarningFields): boolean {
  return (
    value["source"] === "terminal" &&
    isString(value["elwoodSessionId"]) &&
    isString(value["message"]) &&
    isString(value["raw"])
  );
}
