/**
 * Bounded diagnostics for Claude rejection hooks, implementing PRD §6.1 / C-HOOK-20, and
 * Claude's turn-boundary reader, which turns `StopFailure` into a rejection (PRD §5.8, C-API-59).
 */

import { boundedDiagnostic } from "../../core/simple/boundary-signal.ts";
import {
  type BoundarySignalReader,
  defaultBoundarySignal,
  type TurnBoundaryHook,
} from "../../core/simple/turn-types.ts";

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
  const rejected = promptId(event);
  const belongsTo = (acceptedBy: ClaudeBoundaryHook) => {
    const own = promptId(acceptedBy);
    return rejected === undefined || own === undefined || own === rejected;
  };
  return { text: "", failure: { message, agentError, belongsTo } };
};

function promptId(event: ClaudeBoundaryHook): string | undefined {
  return typeof event.prompt_id === "string" && event.prompt_id !== ""
    ? event.prompt_id
    : undefined;
}
