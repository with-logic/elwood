/** Stop/kill fallback for ergonomic close (PRD §5.8, C-API-51). */
import type { ElwoodAgentSession } from "../agent-session.ts";
import { ElwoodError, elwoodError, toError } from "../errors.ts";
/** Stop first, then kill if needed (C-API-51). If both fail, termination_failed
 * preserves the stop diagnostic as cause and the kill diagnostic as killCause, and each
 * one's runtime-cleanup failure (§9.4) as cleanupError and killCleanupError. */
export async function closeSession(live: ElwoodAgentSession): Promise<void> {
  try {
    await live.stop();
  } catch (stopError) {
    try {
      await live.kill();
    } catch (killError) {
      throw elwoodError("termination_failed", "close() failed to stop or kill the session", {
        cause: toError(stopError).message,
        killCause: toError(killError).message,
        ...cleanupDetail("cleanupError", stopError),
        ...cleanupDetail("killCleanupError", killError),
      });
    }
  }
}

/** `{ [key]: message }` when `error` carries a runtime-cleanup failure message. */
function cleanupDetail(key: string, error: unknown): Readonly<Record<string, string>> {
  const message = error instanceof ElwoodError ? error.details["cleanupError"] : undefined;
  return typeof message === "string" ? { [key]: message } : {};
}
