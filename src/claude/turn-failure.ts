/**
 * Reads Claude's own evidence that it REJECTED a turn (PRD §12A.5, C-API-57).
 *
 * Claude's rejection DOES reach a turn-boundary hook: `StopFailure` carries an `error`
 * (a `ClaudeStopFailureError` member such as `rate_limit`, or an adapter-supplied string)
 * plus optional `error_details`. So — unlike Codex, whose evidence is transcript-only — it
 * fits the existing boundary seam, and this reader is a `BoundarySignalReader` that extends
 * `defaultBoundarySignal` rather than a separate activity reader.
 *
 * Previously `defaultBoundarySignal` did not treat `StopFailure` as a boundary at all — only
 * `Stop` was — so a rejected turn installed no oracle and fell through to the quiet-window
 * settle, reporting an empty success. That is the #19 bug. This reader deliberately makes
 * `StopFailure` a boundary whose expected text is empty AND which carries the failure, so the
 * turn ends as the failure it is. `error` is the evidence; an empty `last_assistant_message`
 * is NOT (PRD §12A.3).
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
  // text is empty; the failure rides alongside it so the turn ends as the failure it is.
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
  // BOUND BEFORE USE: a provider payload can be multi-megabyte, so each diagnostic is truncated
  // before it is stored or interpolated, never after.
  const error = bounded(nonBlank(event.error));
  const details = bounded(nonBlank(event.error_details));
  return {
    message: details ?? reason(error),
    ...(error === undefined ? {} : { info: error }),
  };
}

/**
 * A non-empty, non-whitespace string, else `undefined`. A blank `error_details` must NOT be
 * treated as authoritative — it would erase the usable `error` reason and surface a blank
 * `turn_failed` message to consumers.
 */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** A truthful reason even when the hook names no error, so the failure is never empty. */
function reason(error: string | undefined): string {
  return error === undefined ? "Claude rejected the turn." : `Claude rejected the turn: ${error}`;
}

/** Truncate a diagnostic to the cap, preserving `undefined` so callers keep their fallbacks. */
function bounded(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  return message.length <= maxMessageLength ? message : `${message.slice(0, maxMessageLength)}…`;
}
