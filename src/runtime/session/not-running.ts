/** Typed rejection when a session no longer accepts operations (PRD §5.3/§10). */
import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import { elwoodError } from "../../core/errors.ts";

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
