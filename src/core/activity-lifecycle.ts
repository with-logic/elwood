/**
 * Lifecycle-sourced activity builders (status, terminal exit, reap failure).
 * Implements PRD §5.4/§9.4: adapter-neutral lifecycle events, including the
 * C-LIFE-10 reap-failure diagnostic surfaced instead of throwing out of the PTY
 * exit callback.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity.ts";
import type { ElwoodSessionStatus } from "./status-categories.ts";
import type { ElwoodWarningEvent } from "./types.ts";
import { boundedErrorToken, isReapErrorCode } from "./warning-reasons.ts";

export function activityFromStatus(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  status: ElwoodSessionStatus,
): ElwoodActivityEvent {
  return { elwoodSessionId, agent, source: "lifecycle", kind: "status", label: status, status };
}

export function activityFromTerminalExit(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  exitCode: number,
): ElwoodActivityEvent {
  return {
    elwoodSessionId,
    agent,
    source: "lifecycle",
    kind: "terminal_exit",
    label: `${exitCode}`,
    exitCode,
  };
}

/**
 * A best-effort survivor reap failed on an already-exited PTY (C-LIFE-10): the
 * session still reached a terminal status, so this builds the durable, typed,
 * content-free `reap_failed` warning that surfaces the un-reaped-group risk. It
 * carries the leaked leader's process-group id and a normalized error code (never
 * a raw system message), and is routed through the warning persistence path so it
 * persists, replays to late subscribers, and projects `warning`+`activity` — not
 * a single transient activity thrown out of the native exit callback.
 */
export function reapFailureWarning(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  processGroupId: number,
  error: unknown,
): ElwoodWarningEvent {
  // Only an allowlisted reap errno/error-name survives; any raw system message
  // collapses to `UnknownError` via the shared bounded-token helper (§5.7).
  const errorCode = boundedErrorToken(error, isReapErrorCode);
  return {
    elwoodSessionId,
    agent,
    source: "lifecycle",
    code: "reap_failed",
    severity: "warning",
    message: `Could not reap PTY process group ${processGroupId} after exit (${errorCode}).`,
    processGroupId,
    errorCode,
    raw: `reap_failed pgid=${processGroupId} code=${errorCode}`,
  };
}
