/** Normalized native observations for live dashboards (PRD §5.12, C-STATS-01/02). */

export type TokenCounts = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningOutputTokens?: number;
};

export type ClaudeTokenUsage = {
  readonly scope: "response";
  readonly responseId: string;
  readonly counts: TokenCounts;
};

export type CodexTokenUsage = {
  readonly scope: "thread";
  readonly total: TokenCounts;
  readonly last?: TokenCounts;
  readonly contextWindowTokens?: number;
};

export type CodexRateLimitWindow = {
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly windowMinutes?: number;
  readonly resetsAtUnixSeconds?: number;
};

export type CodexRateLimits = {
  readonly limitId?: string;
  readonly recordedAt?: string;
} & (
  | { readonly primary: CodexRateLimitWindow; readonly secondary?: CodexRateLimitWindow }
  | { readonly primary?: never; readonly secondary: CodexRateLimitWindow }
);

export type SubagentObservation = {
  readonly id: string;
  readonly type: string;
  readonly state: "started" | "stopped";
};

export type DashboardActivityFields =
  | { readonly tokenUsage?: never; readonly rateLimits?: never; readonly subagent?: never }
  | {
      readonly source: "transcript";
      readonly agent: "codex";
      readonly transcriptPath: string;
      readonly tokenUsage?: CodexTokenUsage;
      readonly rateLimits?: CodexRateLimits;
      readonly subagent?: never;
    }
  | {
      readonly source: "transcript";
      readonly agent: "claude";
      readonly transcriptPath: string;
      readonly tokenUsage?: ClaudeTokenUsage;
      readonly rateLimits?: never;
      readonly subagent?: never;
    }
  | {
      readonly source: "hook";
      readonly kind: "hook_result";
      readonly subagent: SubagentObservation;
      readonly tokenUsage?: never;
      readonly rateLimits?: never;
    };
