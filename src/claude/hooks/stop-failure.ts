/**
 * Bounded diagnostics for Claude rejection hooks, implementing PRD §6.1 / C-HOOK-20, and
 * Claude's turn-boundary reader, which turns `StopFailure` into a rejection (PRD §5.8, C-API-59).
 */

import { type BoundarySignalReader, defaultBoundarySignal } from "../../core/simple/turn-types.ts";

const maxDiagnosticLength = 2_000;

/** Accepts the structural diagnostic fields so internal adapters share one selector. */
export function stopFailureDiagnostic(event: {
  readonly error?: unknown;
  readonly error_details?: unknown;
}): { readonly message: string; readonly info?: string } {
  const error = diagnosticField(event.error);
  const details = diagnosticField(event.error_details);
  return {
    message:
      details ??
      (error === undefined ? "Claude rejected the turn." : `Claude rejected the turn: ${error}`),
    ...(error === undefined ? {} : { info: error }),
  };
}

/**
 * Claude fires `StopFailure` INSTEAD of `Stop` when it rejects a turn (an unknown model, an API
 * error). It is a boundary that carries no completeness text plus the rejection; `Stop` and every
 * other hook keep the default reading. Its `last_assistant_message` is Claude's own error text,
 * so it is deliberately not the diagnostic (§6.1).
 */
export const claudeBoundarySignal: BoundarySignalReader = (event) =>
  event.hook_event_name === "StopFailure"
    ? { text: "", failure: stopFailureDiagnostic(event) }
    : defaultBoundarySignal(event);

function diagnosticField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.length <= maxDiagnosticLength ? value : `${value.slice(0, maxDiagnosticLength)}…`;
}
