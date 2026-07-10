/**
 * The typed non-fatal warning contract shared across adapters.
 * Implements PRD §5.7 and §8.2: every warning is a named variant carrying only
 * bounded diagnostics (counts, codes, recovery hints) and never raw prompts,
 * transcripts, or conversation content.
 */

import type { PollErrorReason, ReapErrorCode } from "./warning-reasons.ts";

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
      readonly cause: "unparseable" | "oversized" | "unread_backlog";
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
      readonly phase: "poll" | "final_flush";
      readonly raw: string;
    }
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
    };
