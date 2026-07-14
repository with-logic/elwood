/**
 * The typed non-fatal warning contract shared across adapters.
 * Implements PRD §5.7 and §8.2: every warning is a named variant carrying only
 * bounded diagnostics (counts, codes, recovery hints) and never raw prompts,
 * transcripts, or conversation content.
 */

import type { StartupPromptLabelFor } from "./startup-automation.ts";
import type {
  DropCause,
  PollErrorReason,
  PollPhase,
  ReapErrorCode,
  ResizeErrorCode,
} from "./warning-reasons.ts";

export type ElwoodWarningEvent =
  | {
      readonly elwoodSessionId: string;
      readonly agent: "claude" | "codex";
      readonly source: "lifecycle";
      readonly code: "version_unparseable";
      readonly severity: "warning";
      readonly message: string;
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: "codex";
      readonly source: "terminal";
      readonly code: "mcp_server_not_logged_in";
      readonly severity: "warning";
      readonly message: string;
      readonly mcpServerName: string;
      readonly recoveryCommand: string;
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: "codex";
      readonly source: "terminal";
      readonly code: "mcp_startup_incomplete";
      readonly severity: "warning";
      readonly message: string;
      readonly failedServers: readonly string[];
      readonly recoveryCommands: readonly string[];
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: "codex";
      readonly source: "lifecycle";
      readonly code: "codex_default_model_persisted";
      readonly severity: "warning";
      readonly message: string;
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: "claude";
      readonly source: "terminal";
      readonly code: "transcript_records_dropped";
      readonly severity: "warning";
      readonly message: string;
      // Count, byte magnitude, and path only — never raw transcript content.
      readonly droppedCount: number;
      readonly droppedBytes: number;
      // Why data was lost, bounded to a fixed token so cause + cardinality are
      // never false: an unparseable committed record, an over-length record
      // discarded through its next newline, or an unread teardown backlog.
      readonly cause: DropCause;
      readonly transcriptPath: string;
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: "claude";
      readonly source: "terminal";
      readonly code: "transcript_read_error";
      readonly severity: "warning";
      readonly message: string;
      // Count, last error code, and path only — never raw transcript content.
      readonly errorCount: number;
      readonly lastErrorCode: string;
      readonly transcriptPath: string;
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: "claude";
      readonly source: "terminal";
      readonly code: "transcript_poll_stopped";
      readonly severity: "warning";
      readonly message: string;
      // A short, allowlisted error reason only — never raw transcript content.
      readonly reason: PollErrorReason;
      // Which lifecycle phase failed: a live periodic poll or the final flush at
      // PTY exit — so lost trailing shutdown activity is distinguishable from a
      // live-watcher poll failure without a distinct warning code.
      readonly phase: PollPhase;
      readonly raw: string;
    }
  | StartupPromptWriteFailed<"claude">
  | StartupPromptWriteFailed<"codex">
  | {
      readonly elwoodSessionId: string;
      readonly agent: "claude" | "codex";
      readonly source: "lifecycle";
      readonly code: "reap_failed";
      readonly severity: "warning";
      readonly message: string;
      // The leaked leader's process-group id and a normalized, allowlisted error
      // code only (e.g. "EPERM"): enough to locate + explain the un-reaped group,
      // never a raw system message or conversation content (§5.7, C-LIFE-10).
      readonly processGroupId: number;
      readonly errorCode: ReapErrorCode;
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: "claude";
      readonly source: "lifecycle";
      readonly code: "resize_restore_failed";
      readonly severity: "warning";
      readonly message: string;
      // The narrow-bootstrap restore failed with a real (non-closed) resize error,
      // so Claude stays at its safe bootstrap width. Carries only the size Elwood
      // tried to restore and a normalized, allowlisted error code — never a raw
      // system message or conversation content (§5.3, §5.7, C-API-39).
      readonly requestedCols: number;
      readonly requestedRows: number;
      readonly errorCode: ResizeErrorCode;
      readonly raw: string;
    };

/**
 * A rejected startup-prompt PTY write, discriminated by agent so the LABEL is
 * agent-correlated: an impossible pairing like Claude + `update` or Codex +
 * `browser_tools` is unrepresentable (§5.4). The label is a bounded id from the
 * agent's fixed startup-prompt set only — never raw prompt/screen content — and
 * the prompt is left retryable so a later frame re-attempts the write.
 */
export type StartupPromptWriteFailed<A extends "claude" | "codex"> = {
  readonly elwoodSessionId: string;
  readonly agent: A;
  readonly source: "terminal";
  readonly code: "startup_prompt_write_failed";
  readonly severity: "warning";
  readonly message: string;
  readonly label: StartupPromptLabelFor<A>;
  readonly raw: string;
};
