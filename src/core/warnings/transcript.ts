/** Codex transcript listener diagnostics that preserve delivery (PRD §5.7, C-CODEX-20). */
export type TranscriptListenerErrorWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "codex";
  readonly source: "terminal";
  readonly code: "transcript_listener_error";
  readonly severity: "warning";
  readonly message: string;
  readonly channel: "codex:transcript" | "activity";
  readonly raw: string;
};
