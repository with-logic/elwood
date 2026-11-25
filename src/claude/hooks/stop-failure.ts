/**
 * Bounded diagnostics for Claude rejection hooks, implementing PRD §6.1 / C-HOOK-20, and
 * Claude's turn-boundary reader, which turns `StopFailure` into a rejection (PRD §5.8, C-API-59).
 */

import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { normalizeFinalTurnFailure } from "../../core/activity/turn-failure.ts";
import { boundedDiagnostic } from "../../core/simple/boundary-signal.ts";
import {
  type BoundarySignalReader,
  defaultBoundarySignal,
  type TurnBoundaryHook,
} from "../../core/simple/turn-types.ts";
import type { StopFailureEvent } from "./events-extra.ts";
import { claudePromptId } from "./prompt-id.ts";

/** Accepts the structural diagnostic fields so internal adapters share one selector. */
export function stopFailureDiagnostic(event: {
  readonly error?: unknown;
  readonly error_details?: unknown;
}): { readonly message: string; readonly agentError?: string } {
  const error = boundedDiagnostic(event.error);
  const details = boundedDiagnostic(event.error_details);
  return {
    message:
      details ??
      (error === undefined ? "Claude rejected the turn." : `Claude rejected the turn: ${error}`),
    ...(error === undefined ? {} : { agentError: error }),
  };
}

/** Project only the authoritative hook diagnostic, never assistant text. */
export function claudeTurnFailureActivity(
  elwoodSessionId: string,
  event: StopFailureEvent,
): ElwoodActivityEvent {
  const { message: displayMessage, agentError: boundedNativeErrorCode } =
    stopFailureDiagnostic(event);
  const failure = normalizeFinalTurnFailure({
    displayMessage,
    boundedNativeErrorCode,
    nativeDiagnostic: event.error_details,
  });
  const turnId = claudePromptId(event["prompt_id"]);
  return {
    elwoodSessionId,
    agent: "claude",
    source: "hook",
    kind: "turn_failure",
    ...failure,
    hookEventName: event.hook_event_name,
    ...(turnId === undefined ? {} : { turnId }),
    ...(event.transcript_path === undefined ? {} : { transcriptPath: event.transcript_path }),
  };
}

/** The Claude-only fields this reader needs, read as unknown from the adapter-neutral hook. */
type ClaudeBoundaryHook = TurnBoundaryHook & {
  readonly prompt_id?: unknown;
  readonly error?: unknown;
  readonly error_details?: unknown;
};

/**
 * Claude fires `StopFailure` INSTEAD of `Stop` when it rejects a turn (an unknown model, an API
 * error). It is a boundary that carries no completeness text plus the rejection; `Stop` and every
 * other hook keep the default reading. Its `last_assistant_message` is Claude's own error text,
 * so it is deliberately not the diagnostic (§6.1). Claude 2.1.310 names the submission with the
 * same `prompt_id` on `UserPromptSubmit` and `StopFailure`; a rejection naming another
 * submission belongs to an earlier turn whose hook arrived late (C-API-59).
 */
export const claudeBoundarySignal: BoundarySignalReader = (event: ClaudeBoundaryHook) => {
  if (event.hook_event_name !== "StopFailure") return defaultBoundarySignal(event);
  const { message, agentError } = stopFailureDiagnostic(event);
  const rejected = claudePromptId(event.prompt_id);
  const belongsTo = (acceptedBy: ClaudeBoundaryHook) => {
    const own = claudePromptId(acceptedBy.prompt_id);
    return rejected === undefined || own === undefined || own === rejected;
  };
  return { text: "", failure: { message, agentError, belongsTo } };
};
