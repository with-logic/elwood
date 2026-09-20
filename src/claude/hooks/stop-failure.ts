/** Bounded diagnostics for Claude rejection hooks, implementing PRD §6.1 / C-HOOK-20. */

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

function diagnosticField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}…`;
}
