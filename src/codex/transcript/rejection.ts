/**
 * Read a committed Codex failed `task_complete` (PRD §5.4 / §5.8, C-API-60/65).
 * The record supplies the turn ID for live activity. The ergonomic boundary
 * separately matches that ID to its own accepted `UserPromptSubmit`.
 */

import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { normalizeFinalTurnFailure } from "../../core/activity/turn-failure.ts";
import { isRecord } from "../../core/predicates.ts";
import { boundedDiagnostic, type TurnFailure } from "../../core/simple/boundary-signal.ts";
import { confirmNativeBoundary } from "../../core/simple/native-boundary.ts";

// Codex 0.171.0 collapses workspace-credit depletion into usage_limit_exceeded.
// Its committed ErrorEvent carries these fixed diagnostics without the original subtype.
const workspaceCreditMessages: ReadonlySet<unknown> = new Set([
  "Your workspace is out of credits. Add credits to continue.",
  "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
]);

function readFailedTask(item: unknown) {
  if (!isRecord(item) || item["type"] !== "event_msg") return undefined;
  const payload = item["payload"];
  if (!isRecord(payload) || payload["type"] !== "task_complete") return undefined;
  const error = payload["error"];
  const turnId = payload["turn_id"];
  if (!isRecord(error) || typeof turnId !== "string" || turnId.trim() === "") return undefined;
  return { turnId, error };
}

function codexFailureDiagnostic(error: Readonly<Record<string, unknown>>): TurnFailure {
  const agentError = errorInfoName(error["codex_error_info"]);
  const message =
    boundedDiagnostic(error["message"]) ??
    (agentError === undefined
      ? "Codex rejected the turn."
      : `Codex rejected the turn: ${agentError}`);
  return { message, agentError };
}

/** A rejected turn's id and failure, or `undefined` for every other transcript item. */
export function codexTurnRejection(item: unknown) {
  const task = readFailedTask(item);
  return task && { turnId: task.turnId, failure: codexFailureDiagnostic(task.error) };
}

/** Project a committed failed task without interpreting any transcript prose. */
export function codexTurnFailureActivity(
  elwoodSessionId: string,
  path: string,
  item: unknown,
): ElwoodActivityEvent | undefined {
  const task = readFailedTask(item);
  if (!task) return undefined;
  const { turnId, error } = task;
  const { message: displayMessage, agentError: boundedNativeErrorCode } =
    codexFailureDiagnostic(error);
  const failure = normalizeFinalTurnFailure({
    displayMessage,
    boundedNativeErrorCode:
      boundedNativeErrorCode === "usage_limit_exceeded" &&
      workspaceCreditMessages.has(error["message"])
        ? "insufficient_quota"
        : boundedNativeErrorCode,
    nativeDiagnostic: error["message"],
  });
  return {
    elwoodSessionId,
    agent: "codex",
    source: "transcript",
    kind: "turn_failure",
    ...failure,
    transcriptPath: path,
    turnId,
  };
}

/** Ends the rejected turn whose id the item names; any other item is ignored. */
export function confirmCodexRejection(session: object, item: unknown): void {
  const rejection = codexTurnRejection(item);
  if (rejection === undefined) return;
  const signal = { text: "", failure: rejection.failure };
  confirmNativeBoundary(session, { kind: "stop", turnId: rejection.turnId, signal });
}

// Codex's `CodexErrorInfo` is a bare variant name (`"other"`, `"usage_limit_exceeded"`) or a
// one-key object for a variant with fields (`{"http_connection_failed":{...}}`).
function errorInfoName(info: unknown): string | undefined {
  if (!isRecord(info)) return boundedDiagnostic(info);
  const names = Object.keys(info);
  return names.length === 1 ? boundedDiagnostic(names[0]) : undefined;
}
