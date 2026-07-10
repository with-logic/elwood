/**
 * Lifecycle-sourced activity builders (status, terminal exit, reap failure).
 * Implements PRD §5.4/§9.4: adapter-neutral lifecycle events, including the
 * C-LIFE-10 reap-failure diagnostic surfaced instead of throwing out of the PTY
 * exit callback.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity.ts";
import type { ElwoodSessionStatus } from "./status-categories.ts";

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
 * session still reached a terminal status, so this surfaces the un-reaped-group
 * risk as a diagnostic rather than throwing out of the native exit callback.
 */
export function activityFromReapFailure(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  error: unknown,
): ElwoodActivityEvent {
  const cause = error instanceof Error ? error.message : String(error);
  return {
    elwoodSessionId,
    agent,
    source: "lifecycle",
    kind: "warning",
    label: "reap_failed",
    text: `Could not reap the PTY process group after exit: ${cause}`,
  };
}
