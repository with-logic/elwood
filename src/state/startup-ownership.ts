/** Startup owns publication rollback; builders activate inside their cleanup guard (C-API-20). */
import {
  type LaunchOwnership,
  type LaunchReservation,
  reserveLaunchOwnership,
} from "./launch-ownership.ts";

export async function withLaunchOwnership<T>(
  sessionDir: string,
  reservation: LaunchReservation | undefined,
  build: (ownership: LaunchOwnership, activate: () => void) => Promise<T>,
): Promise<T> {
  const ownership = reservation ?? reserveLaunchOwnership(sessionDir);
  try {
    return await build(ownership, ownership.commit);
  } catch (error) {
    if (reservation === undefined) ownership.rollback();
    throw error;
  }
}
