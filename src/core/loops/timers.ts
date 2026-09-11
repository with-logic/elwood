/**
 * Injectable one-shot, unreferenced timers for recurring loops: the scheduler seam
 * and the per-loop due/expiry timer bank. Implements PRD §5.9 and C-LOOP-05/C-LOOP-13.
 * The cadence arithmetic that drives the bank lives in `timing.ts`. The seam's
 * contract is deliberately loose — an injected scheduler MAY still fire a timer
 * after `cancel` — so every timer callback re-checks that its loop still exists and
 * the scheduler is live before acting.
 */

export type LoopTimer = { readonly cancel: () => void };
export type LoopTimerScheduler = (run: () => void, delayMs: number) => LoopTimer;

/** Production timer seam; tests inject a deterministic scheduler instead. */
export const scheduleLoopTimer: LoopTimerScheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
};

export class LoopTimerBank {
  private readonly timers = new Map<string, LoopTimer>();
  private readonly schedule: LoopTimerScheduler;

  constructor(schedule: LoopTimerScheduler) {
    this.schedule = schedule;
  }

  arm(kind: "due" | "expiry", loopId: string, delayMs: number, run: () => void): void {
    const key = `${kind}:${loopId}`;
    this.timers.get(key)?.cancel();
    const timer = this.schedule(
      () => {
        this.timers.delete(key);
        run();
      },
      Math.max(0, delayMs),
    );
    this.timers.set(key, timer);
  }

  cancelDue(loopId: string): void {
    this.cancel(`due:${loopId}`);
  }

  cancelLoop(loopId: string): void {
    this.cancelDue(loopId);
    this.cancel(`expiry:${loopId}`);
  }

  clear(): void {
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
  }

  private cancel(key: string): void {
    this.timers.get(key)?.cancel();
    this.timers.delete(key);
  }
}
