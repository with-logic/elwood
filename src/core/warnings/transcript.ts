/** Transcript observer diagnostics and native quota warnings (PRD §5.4/§5.7). */
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

/** Affirmative usage-cap rejection from a committed Claude transcript record. */
export type ClaudeUsageLimitWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "claude";
  readonly source: "transcript";
  readonly code: "usage_limit_reached";
  readonly severity: "warning";
  readonly message: string;
  readonly transcriptPath: string;
  readonly turnId?: string;
  readonly limitName?: string;
  readonly nativeLimitType?: string;
  readonly resetsAtUnixSeconds?: number;
  readonly raw: string;
};
