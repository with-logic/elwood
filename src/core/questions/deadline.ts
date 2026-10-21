/** Keep positive finite answer deadlines within Node's timer range (PRD §4). */
import { type DeadlineClock, scheduleDeadline } from "../timers.ts";

const clock: DeadlineClock = {
  now: () => performance.now(),
  setTimer: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function questionDeadline(timeoutMs: number, expire: () => void): () => void {
  return scheduleDeadline(clock.now() + timeoutMs, timeoutMs, expire, clock);
}
