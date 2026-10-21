/** Node's maximum safe timer delay shared by bounded deadlines (PRD §4/§12A). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type DeadlineClock = {
  readonly now: () => number;
  readonly setTimer: (handler: () => void, delayMs: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
};

/** Keep an absolute deadline across capped timer intervals; cancellation clears the latest one.
 * deadlineAtMs is an absolute millisecond reading in the supplied clock's time base.
 * The caller supplies its first delay to preserve when its deadline starts counting. */
export function scheduleDeadline(
  options: { readonly deadlineAtMs: number; readonly initialDelayMs: number },
  expire: () => void,
  clock: DeadlineClock,
): () => void {
  const tick = () => {
    const remaining = options.deadlineAtMs - clock.now();
    if (remaining > 0) timer = clock.setTimer(tick, Math.min(remaining, MAX_TIMER_DELAY_MS));
    else expire();
  };
  let timer = clock.setTimer(tick, Math.min(options.initialDelayMs, MAX_TIMER_DELAY_MS));
  return () => clock.clearTimer(timer);
}
