/** Fresh startup owns the same publication/rollback transaction as resume (C-API-20). */
import {
  type LaunchOwnership,
  type LaunchReservation,
  reserveLaunchOwnership,
} from "./launch-ownership.ts";

export async function withLaunchOwnership<T>(
  sessionDir: string,
  reservation: LaunchReservation | undefined,
  build: (ownership: LaunchOwnership) => Promise<T>,
): Promise<T> {
  const ownership = reservation ?? reserveLaunchOwnership(sessionDir);
  try {
    const result = await build(ownership);
    if (reservation === undefined) ownership.commit();
    return result;
  } catch (error) {
    if (reservation === undefined) ownership.rollback();
    throw error;
  }
}
