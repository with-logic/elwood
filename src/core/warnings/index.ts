/**
 * Non-fatal adapter warnings (PRD §5.7, §8.2): named variants carrying only
 * diagnostics (cause/phase labels, error codes, recovery hints) — no counts or
 * byte magnitudes — and never raw prompts, transcripts, or conversation content.
 * Most error-code fields are allowlisted tokens (`reasons.ts`); the one
 * exception is `transcript_read_error.lastErrorCode`, which the PRD types as the
 * raw fs errno string (a system-controlled code, never transcript content).
 * Warnings are live-only: emitted once when observed, never persisted.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import type { StartupPromptLabelFor } from "../startup/automation.ts";
import type * as lifecycle from "./lifecycle.ts";
import type {
  DropCause,
  PollErrorReason,
  PollPhase,
  ReapErrorCode,
  ResizeErrorCode,
} from "./reasons.ts";
import type { TranscriptListenerErrorWarning } from "./transcript.ts";

export type ElwoodWarningEvent =
  | TranscriptListenerErrorWarning
  | {
      readonly elwoodSessionId: string;
      readonly agent: ElwoodAgentKind;
      readonly source: "lifecycle";
      readonly code: "version_unparseable";
      readonly severity: "warning";
      readonly message: string;
      readonly raw: string;
    }
  | lifecycle.AgentUpdateFailedWarning
  | lifecycle.ObserverFailureWarning
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
      readonly agent: "claude";
      readonly source: "terminal";
      readonly code: "login_expired";
      readonly severity: "warning";
      readonly message: string;
      // A Claude session's login lapsed/was revoked AFTER it was usable, so it can no longer act
      // until re-authenticated. Content-free: only the FIXED literal `/login` recovery command,
      // never a raw banner or session content. The session stays alive so the caller can recover
      // in place via `session.login()`, tear down, or re-auth out of band (§5.3, C-CLAUDE-18).
      readonly recoveryCommand: "/login";
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
      // Content-free: the clipboard restore after a Codex image attach failed, so the user's
      // prior clipboard may be lost. No clipboard contents (C-API-46).
      readonly elwoodSessionId: string;
      readonly agent: "codex";
      readonly source: "lifecycle";
      readonly code: "clipboard_restore_failed";
      readonly severity: "warning";
      readonly message: string;
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      // Shared: either adapter's bounded transcript cursor can drop committed data.
      readonly agent: ElwoodAgentKind;
      readonly source: "terminal";
      readonly code: "transcript_records_dropped";
      readonly severity: "warning";
      readonly message: string;
      // Why data was lost, bounded to a fixed token: an unparseable committed record,
      // an over-length record discarded through its next newline, or an unread
      // teardown backlog. Live-only and count-free; drops are coalesced to at most
      // one warning per (path, cause) per scan pass, not one per record.
      readonly cause: DropCause;
      readonly transcriptPath: string;
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: ElwoodAgentKind;
      readonly source: "terminal";
      readonly code: "transcript_read_error";
      readonly severity: "warning";
      readonly message: string;
      // The raw fs errno string (or "UNKNOWN") and path only — never raw
      // transcript content. Per the PRD this is the one error-code field NOT
      // collapsed to an allowlist. One live warning per contained read error —
      // never a running count.
      readonly lastErrorCode: string;
      readonly transcriptPath: string;
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: ElwoodAgentKind;
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
      readonly agent: ElwoodAgentKind;
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
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: ElwoodAgentKind;
      readonly source: "lifecycle";
      readonly code: "initial_ready_fallback";
      readonly severity: "warning";
      readonly message: string;
      // Recording the one-shot initial-ready transition threw (a lifecycle-event
      // listener), so Elwood released the control queue directly (anti-starvation)
      // while emitted lifecycle events may be stale. Content-free — never a raw
      // system message or conversation content (§5.3, §5.7, C-API-42).
      readonly raw: string;
    };

/**
 * A rejected startup-prompt PTY write, discriminated by agent so the LABEL is
 * agent-correlated: an impossible pairing like Claude + `update` or Codex +
 * `browser_tools` is unrepresentable (§5.4). The label is a bounded id from the
 * agent's fixed startup-prompt set only — never raw prompt/screen content — and
 * the prompt is left retryable so a later frame re-attempts the write.
 */
export type StartupPromptWriteFailed<A extends ElwoodAgentKind> = {
  readonly elwoodSessionId: string;
  readonly agent: A;
  readonly source: "terminal";
  readonly code: "startup_prompt_write_failed";
  readonly severity: "warning";
  readonly message: string;
  readonly label: StartupPromptLabelFor<A>;
  readonly raw: string;
};
