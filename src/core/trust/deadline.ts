/**
 * The bounded trust-automation budget, spent only while its gate is on screen
 * (PRD §5.4, C-TRUST-01, C-ATTN-03). A frame without the gate pauses it and the
 * gate's return resumes the remainder, so the time a CLI spends painting its next
 * screen after an answer can never become a human block for a gate nobody can see.
 */

/** Five seconds of on-screen time before an authorized gate falls back to a human block. */
export const gateBudgetMs = 5_000;

type Running = { readonly timer: ReturnType<typeof setTimeout>; readonly expire: () => void };

export class GateDeadline {
  private running: Running | undefined;
  private paused: { readonly remainingMs: number; readonly expire: () => void } | undefined;
  private endsAtMs = 0;

  /** Absolute end of the current on-screen interval; attempts stop writing at it. */
  get deadlineAtMs(): number {
    return this.endsAtMs;
  }

  /** A fresh full budget; any earlier running or paused budget is discarded. */
  start(budgetMs: number, expire: () => void): void {
    this.cancel();
    this.run(budgetMs, expire);
  }

  /** The gate left the frame: stop spending its budget. No-op unless running. */
  pause(): void {
    const running = this.running;
    if (running === undefined) return;
    clearTimeout(running.timer);
    this.running = undefined;
    this.paused = {
      remainingMs: Math.max(0, this.endsAtMs - Date.now()),
      expire: running.expire,
    };
  }

  /** The gate is on the frame again: spend what remains. No-op unless paused. */
  resume(): void {
    const paused = this.paused;
    if (paused !== undefined) this.run(paused.remainingMs, paused.expire);
  }

  cancel(): void {
    clearTimeout(this.running?.timer);
    this.running = undefined;
    this.paused = undefined;
  }

  private run(budgetMs: number, expire: () => void): void {
    this.paused = undefined;
    this.endsAtMs = Date.now() + budgetMs;
    const timer = setTimeout(() => {
      this.running = undefined;
      expire();
    }, budgetMs);
    timer.unref();
    this.running = { timer, expire };
  }
}
