/** Transcript observer diagnostics that preserve delivery (PRD §5.7). */
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

export type ClaudePromptListenerErrorWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "claude";
  readonly source: "terminal";
  readonly code: "claude_prompt_listener_error";
  readonly severity: "warning";
  readonly message: string;
  readonly channel: "activity";
  readonly raw: string;
};
