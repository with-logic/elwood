/** Keep positive finite answer deadlines within Node's timer range (PRD §4). */
import { deadlineClock, scheduleDeadline } from "../timers.ts";

export function questionDeadline(timeoutMs: number, expire: () => void): () => void {
  return scheduleDeadline(
    { deadlineAtMs: deadlineClock.now() + timeoutMs, initialDelayMs: timeoutMs },
    expire,
    deadlineClock,
  );
}
