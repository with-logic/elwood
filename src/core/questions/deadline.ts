/** Keep positive finite answer deadlines within Node's timer range (PRD §4). */
import { MAX_TIMER_DELAY_MS } from "../timers.ts";

export function questionDeadline(timeoutMs: number, expire: () => void): () => void {
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) expire();
    else timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  schedule();
  return () => clearTimeout(timer);
}
