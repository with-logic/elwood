/** Typed rejection when a session no longer accepts operations (PRD §5.3/§10). */
import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import { elwoodError } from "../../core/errors.ts";

export function notRunningError(agent: ElwoodAgentKind): Error {
  const title = agent === "claude" ? "Claude" : "Codex";
  return elwoodError("session_not_running", `${title} session is not running.`);
}
