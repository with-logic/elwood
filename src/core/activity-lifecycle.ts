/**
 * Lifecycle-sourced activity builders (status, terminal exit, reap failure).
 * Implements PRD §5.4/§9.4: adapter-neutral lifecycle events, including the
 * C-LIFE-10 reap-failure diagnostic surfaced instead of throwing out of the PTY
 * exit callback.
 */

import type { ElwoodActivityEvent, ElwoodAgentKind } from "./activity.ts";
import type { ElwoodSessionStatus } from "./status-categories.ts";
import type { ElwoodWarningEvent } from "./types.ts";

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
  const errorCode = normalizeReapErrorCode(error);
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

/**
 * A stable, bounded code for a reap failure: the errno (e.g. `EPERM`) when the
 * cause is an `ErrnoException`, else the Error's `name`, else the stringified
 * non-Error cause. Never the raw system message — that could carry an env path.
 */
function normalizeReapErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  if (error instanceof Error) return error.name;
  return String(error);
}

/**
 * The `activity` projection of a `reap_failed` warning, used where only the
 * lifecycle activity view is needed (kept parallel to `activityFromWarning`).
 */
export function activityFromReapFailure(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  processGroupId: number,
  error: unknown,
): ElwoodActivityEvent {
  const warning = reapFailureWarning(agent, elwoodSessionId, processGroupId, error);
  return {
    elwoodSessionId,
    agent,
    source: "lifecycle",
    kind: "warning",
    label: warning.code,
    text: warning.message,
    raw: warning,
  };
}
