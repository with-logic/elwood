/** Transcript listener diagnostics that preserve delivery (PRD §5.7). */
export type TranscriptListenerErrorWarning = {
  readonly elwoodSessionId: string;
  readonly source: "terminal";
  readonly code: "transcript_listener_error";
  readonly severity: "warning";
  readonly message: string;
  readonly raw: string;
} & (
  | { readonly agent: "claude"; readonly channel: "activity" }
  | { readonly agent: "codex"; readonly channel: "codex:transcript" | "activity" }
);
