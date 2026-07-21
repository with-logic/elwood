/**
 * Runtime validation for persisted typed warning events.
 * Implements PRD §5.7, §8.2, and §10: every persisted warning is a named variant
 * carrying only bounded diagnostics; an unknown or malformed shape invalidates
 * the record rather than resuming with a corrupted snapshot. The validator map is
 * keyed exhaustively by `ElwoodWarningEvent["code"]`, so adding a warning variant
 * fails to compile until it is validated here.
 */

import {
  LOGIN_EXPIRED_MESSAGE,
  LOGIN_EXPIRED_RAW,
  LOGIN_RECOVERY_COMMAND,
} from "../claude/login-expired.ts";
import type { ElwoodAgentKind } from "../core/activity.ts";
import { isStartupPromptLabelForAgent } from "../core/startup-automation.ts";
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
  // Content-free auth diagnostic: STRICT — the message/raw must be the exact
  // canonical constants and no unexpected (content-bearing) key may be present, so
  // a resumed warning can never smuggle a raw banner or conversation text back to
  // disk (§5.3, §5.7, §8.3, C-CLAUDE-18).
  login_expired: (value) =>
    value["agent"] === "claude" &&
    value["source"] === "terminal" &&
    isString(value["elwoodSessionId"]) &&
    value["recoveryCommand"] === LOGIN_RECOVERY_COMMAND &&
    value["message"] === LOGIN_EXPIRED_MESSAGE &&
    value["raw"] === LOGIN_EXPIRED_RAW &&
    hasOnlyKeys(value, LOGIN_EXPIRED_KEYS),
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
  // Content-free clipboard-restore-failure diagnostic: canonical fixed message/raw
  // and an exact key allowlist, so no clipboard contents or extra fields can ride
  // through this bounded channel on a resumed record (C-API-46).
  clipboard_restore_failed: (value) =>
    value["agent"] === "codex" &&
    value["source"] === "lifecycle" &&
    isString(value["elwoodSessionId"]) &&
    value["message"] === CLIPBOARD_RESTORE_FAILED_MESSAGE &&
    value["raw"] === "clipboard_restore_failed" &&
    hasOnlyKeys(value, CLIPBOARD_RESTORE_FAILED_KEYS),
  transcript_records_dropped: (value) =>
    sharedTerminalBase(value) &&
    isPositiveCount(value["droppedCount"]) &&
    isCount(value["droppedBytes"]) &&
    isDropCause(value["cause"]) &&
    isString(value["transcriptPath"]),
  transcript_read_error: (value) =>
    sharedTerminalBase(value) &&
    isPositiveCount(value["errorCount"]) &&
    isString(value["lastErrorCode"]) &&
    isString(value["transcriptPath"]),
  // `reason` is validated against the SAME allowlist the producer draws from, so a
  // non-allowlisted reason cannot round-trip. Both adapters can stop a poll.
  transcript_poll_stopped: (value) =>
    sharedTerminalBase(value) && isPollErrorReason(value["reason"]) && isPollPhase(value["phase"]),
  // The `label` is bounded to the failing AGENT's own startup-prompt labels, so a
  // persisted failure round-trips neither a raw prompt nor an off-agent pairing (§5.4).
  startup_prompt_write_failed: (value) =>
    sharedTerminalBase(value) && isStartupPromptLabelForAgent(value["agent"], value["label"]),
  // Content-free lifecycle diagnostic: the leaked group's pgid (a real leader pid, so
  // a safe integer > 1) + an ALLOWLISTED normalized error code, per agent (§5.7).
  reap_failed: (value) =>
    (value["agent"] === "claude" || value["agent"] === "codex") &&
    value["source"] === "lifecycle" &&
    isString(value["elwoodSessionId"]) &&
    isString(value["message"]) &&
    isProcessGroupId(value["processGroupId"]) &&
    isReapErrorCode(value["errorCode"]) &&
    isString(value["raw"]),
  // Content-free lifecycle diagnostic: the size Elwood tried to restore (positive
  // dimensions) + an ALLOWLISTED normalized error code, never a raw message (§5.3).
  resize_restore_failed: (value) =>
    value["agent"] === "claude" &&
    value["source"] === "lifecycle" &&
    isString(value["elwoodSessionId"]) &&
    isString(value["message"]) &&
    isPositiveCount(value["requestedCols"]) &&
    isPositiveCount(value["requestedRows"]) &&
    isResizeErrorCode(value["errorCode"]) &&
    isString(value["raw"]),
  // Content-free lifecycle diagnostic: only a bounded, allowlisted `reason`
  // (`persist`/`listener`) distinguishing the failing stage, never content (§5.3).
  initial_ready_fallback: (value) =>
    value["agent"] === "claude" &&
    value["source"] === "lifecycle" &&
    isString(value["elwoodSessionId"]) &&
    isString(value["message"]) &&
    (value["reason"] === "persist" || value["reason"] === "listener") &&
    isString(value["raw"]),
} satisfies Record<ElwoodWarningEvent["code"], WarningValidator>;

/** Canonical, content-free copy for the clipboard-restore-failed warning (C-API-46). */
export const CLIPBOARD_RESTORE_FAILED_MESSAGE =
  "Elwood could not restore the clipboard after attaching an image.";

/** The complete set of keys a `clipboard_restore_failed` warning may carry. */
const CLIPBOARD_RESTORE_FAILED_KEYS: readonly string[] = [
  "elwoodSessionId",
  "agent",
  "source",
  "code",
  "severity",
  "message",
  "raw",
];

/** The complete set of keys a `login_expired` warning may carry (no extras). */
const LOGIN_EXPIRED_KEYS: readonly string[] = [
  "elwoodSessionId",
  "agent",
  "source",
  "code",
  "severity",
  "message",
  "recoveryCommand",
  "raw",
];

/** True when `value` has exactly `keys` and no additional own properties. */
function hasOnlyKeys(value: WarningFields, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((k) => keys.includes(k));
}

/** A persisted PTY leader process-group id: a real pid, so a safe integer > 1. */
function isProcessGroupId(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 1;
}

/** A terminal warning on either adapter (shared drop + startup-prompt shapes). */
function sharedTerminalBase(v: WarningFields): v is WarningFields & { agent: ElwoodAgentKind } {
  return (v["agent"] === "claude" || v["agent"] === "codex") && terminalBase(v);
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
