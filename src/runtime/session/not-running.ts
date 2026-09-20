/** Typed rejection when a session no longer accepts operations (PRD §5.3/§10). */
import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import { elwoodError, toError } from "../../core/errors.ts";

import { terminalStatuses } from "../../core/status-categories.ts";
import type { ElwoodSessionStatus } from "../../core/types.ts";

export function notRunningError(agent: ElwoodAgentKind): Error {
  const title = agent === "claude" ? "Claude" : "Codex";
  return elwoodError("session_not_running", `${title} session is not running.`);
}

/**
 * Once shutdown begins the PTY is, or is about to be, signalled, so held submissions
 * reject now with `session_not_running` rather than waiting on a shutdown that may
 * fail and need a retry (§9 keeps the shutdown itself retryable).
 */
export function closingController(rejectHeldInput: () => void): AbortController {
  const closing = new AbortController();
  closing.signal.addEventListener("abort", rejectHeldInput, { once: true });
  return closing;
}

/** Normalize operation failures and reject operations after a terminal status. */
export function runSessionOperation<T>(
  agent: ElwoodAgentKind,
  status: ElwoodSessionStatus,
  work: () => Promise<T> | T,
  allowTerminal: boolean,
): Promise<T> {
  if (!allowTerminal && terminalStatuses.has(status)) return Promise.reject(notRunningError(agent));
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(toError(error));
  }
}
