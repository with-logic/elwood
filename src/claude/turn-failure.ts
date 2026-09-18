/**
 * Reads Claude's own evidence that it REJECTED a turn (PRD §12A.5, C-API-57).
 *
 * Claude's rejection DOES reach a turn-boundary hook: `StopFailure` carries an `error`
 * (a `ClaudeStopFailureError` member such as `rate_limit`, or an adapter-supplied string)
 * plus optional `error_details`. So — unlike Codex, whose evidence is transcript-only — it
 * fits the existing boundary seam, and this reader is a `BoundarySignalReader` that extends
 * `defaultBoundarySignal` rather than a separate activity reader.
 *
 * `StopFailure` is a turn BOUNDARY either way: before this it returned `""` (clearing the
 * oracle → quiet settle → empty success), which is exactly the #19 bug. It now returns the
 * object form so the same boundary additionally reports the failure. `error` is the evidence;
 * an empty `last_assistant_message` is NOT (PRD §12A.3).
 */

import {
  type BoundarySignalReader,
  defaultBoundarySignal,
  type TurnFailure,
} from "../core/simple/turn-types.ts";

/** Cap on the reason text carried out of the hook, so a huge payload stays bounded. */
const maxMessageLength = 2_000;

export const claudeBoundarySignal: BoundarySignalReader = (event) => {
  const failure = stopFailure(event);
  if (failure === undefined) return defaultBoundarySignal(event);
  // A `StopFailure` ends the turn and carries no completed assistant text, so the expected
  // text is empty — the SAME boundary as before, now reporting why it failed.
  return { text: "", failure };
};

/**
 * The failure a `StopFailure` hook reports, or `undefined` for any other hook. The hook's
 * own `error` field is the evidence; its absence leaves the event to the default reader.
 */
function stopFailure(event: {
  readonly hook_event_name?: string;
  readonly error?: unknown;
  readonly error_details?: unknown;
}): TurnFailure | undefined {
  if (event.hook_event_name !== "StopFailure") return undefined;
  const error = typeof event.error === "string" ? event.error : undefined;
  const details = typeof event.error_details === "string" ? event.error_details : undefined;
  return {
    message: bounded(details ?? reason(error)),
    ...(error === undefined ? {} : { info: error }),
  };
}

/** A truthful reason even when the hook names no error, so the failure is never empty. */
function reason(error: string | undefined): string {
  return error === undefined ? "Claude rejected the turn." : `Claude rejected the turn: ${error}`;
}

function bounded(message: string): string {
  return message.length <= maxMessageLength ? message : `${message.slice(0, maxMessageLength)}…`;
}
