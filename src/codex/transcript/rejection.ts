/**
 * Read a committed Codex failed `task_complete` (PRD §5.4 / §5.8, C-API-60/65).
 * The record supplies the turn ID for live activity. The ergonomic boundary
 * separately matches that ID to its own accepted `UserPromptSubmit`.
 */

import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import {
  normalizeFinalTurnFailure,
  substituteErrorCodes,
} from "../../core/activity/turn-failure.ts";
import { isRecord } from "../../core/predicates.ts";
import { boundedDiagnostic, type TurnFailure } from "../../core/simple/boundary-signal.ts";
import { confirmNativeBoundary } from "../../core/simple/native-boundary.ts";
import type { CodexTranscriptEvent } from "./types.ts";

// Codex 0.171.0 and 0.172.0 record workspace-credit depletion and the service's
// `insufficient_quota` as usage_limit_exceeded, with one of these fixed sentences in place of
// the original code.
const quotaOrCreditMessages: ReadonlySet<unknown> = new Set([
  "Your workspace is out of credits. Add credits to continue.",
  "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
  "Quota exceeded. Check your plan and billing details.",
]);

// The HTTP statuses that identify a failure more narrowly than the kind recording them:
// 402 Payment Required and 429 Too Many Requests.
const statusCodes: ReadonlyMap<unknown, string> = new Map([
  [402, substituteErrorCodes.quota_or_credit],
  [429, substituteErrorCodes.rate_limited],
]);

function readFailedTask(item: unknown) {
  if (!isRecord(item) || item["type"] !== "event_msg") return undefined;
  const payload = item["payload"];
  if (!isRecord(payload) || payload["type"] !== "task_complete") return undefined;
  const error = payload["error"];
  const turnId = payload["turn_id"];
  if (!isRecord(error) || typeof turnId !== "string" || turnId.trim() === "") return undefined;
  return { turnId, error, errorInfo: readErrorInfo(error["codex_error_info"]) };
}

type FailedTask = NonNullable<ReturnType<typeof readFailedTask>>;

function codexFailureDiagnostic({ error, errorInfo }: FailedTask): TurnFailure {
  const agentError = errorInfo.name;
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
  return task && { turnId: task.turnId, failure: codexFailureDiagnostic(task) };
}

/** Project a committed failed task without interpreting any transcript prose. */
export function codexTurnFailureActivity({
  elwoodSessionId,
  path: transcriptPath,
  item,
}: Pick<CodexTranscriptEvent, "elwoodSessionId" | "path" | "item">):
  | ElwoodActivityEvent
  | undefined {
  const task = readFailedTask(item);
  if (!task) return undefined;
  const failure = normalizeFinalTurnFailure({
    displayMessage: codexFailureDiagnostic(task).message,
    boundedNativeErrorCode: classificationCode(task),
    nativeDiagnostic: task.error["message"],
  });
  return {
    elwoodSessionId,
    agent: "codex",
    source: "transcript",
    kind: "turn_failure",
    ...failure,
    transcriptPath,
    turnId: task.turnId,
  };
}

/** Ends the rejected turn whose id the item names; any other item is ignored. */
export function confirmCodexRejection(session: object, item: unknown): void {
  const rejection = codexTurnRejection(item);
  if (rejection === undefined) return;
  const signal = { text: "", failure: rejection.failure };
  confirmNativeBoundary(session, { kind: "stop", turnId: rejection.turnId, signal });
}

/**
 * The native code to classify a failed task by. Codex records quota and credit exhaustion as
 * `usage_limit_exceeded` with a fixed sentence, and keeps a 402 or 429 only as the status of a
 * transport kind. For those it is a code of the narrower §5.4 category, and otherwise the kind.
 * A recognized code in the diagnostic itself still takes precedence.
 */
function classificationCode({ error, errorInfo }: FailedTask): string | undefined {
  if (errorInfo.name === "usage_limit_exceeded" && quotaOrCreditMessages.has(error["message"]))
    return substituteErrorCodes.quota_or_credit;
  const status = isRecord(errorInfo.fields) ? errorInfo.fields["http_status_code"] : undefined;
  return statusCodes.get(status) ?? errorInfo.name;
}

// Codex's `CodexErrorInfo` is a bare kind name (`"other"`, `"usage_limit_exceeded"`) or a one-key
// object for a kind with fields (`{"http_connection_failed":{"http_status_code":402}}`).
function readErrorInfo(info: unknown): {
  readonly name?: string | undefined;
  readonly fields?: unknown;
} {
  if (!isRecord(info)) return { name: boundedDiagnostic(info) };
  const [only, ...others] = Object.entries(info);
  return only === undefined || others.length > 0
    ? {}
    : { name: boundedDiagnostic(only[0]), fields: only[1] };
}
