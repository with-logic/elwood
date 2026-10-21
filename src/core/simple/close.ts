/** Stop/kill fallback for ergonomic close (PRD §5.8, C-API-51). */
import type { ElwoodAgentSession } from "../agent-session.ts";
import { elwoodError, toError } from "../errors.ts";
/** Stop first, then kill if needed (C-API-51). If both fail, termination_failed
 * preserves the stop diagnostic as cause and the kill diagnostic as killCause. */
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
      });
    }
  }
}
