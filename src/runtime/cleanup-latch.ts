/**
 * Coalesces runtime-cleanup attempts while keeping a FAILED cleanup retryable.
 * PRD §9.4 requires that a settled cleanup failure is not permanently sticky — a
 * later explicit stop/kill/teardown must run a fresh attempt. A plain `??=` cache
 * would latch a rejected promise forever, so this latch clears its cache on
 * failure (identity-guarded so a newer attempt always wins). Implements PRD §9.4.
 */

export class CleanupLatch {
  private pending: Promise<void> | undefined;
  private readonly run: () => Promise<void>;

  constructor(run: () => Promise<void>) {
    this.run = run;
  }

  /**
   * Runs cleanup, coalescing concurrent callers onto one in-flight attempt. On
   * failure the cache is cleared so the NEXT call re-runs `run` instead of
   * replaying the old rejection; the rejection still propagates to this caller.
   */
  attempt(): Promise<void> {
    // A pending attempt (in-flight OR already-settled-successful) is reused; a
    // rejected one cleared its own cache below, so `pending` is only ever the live
    // attempt — no identity guard is needed before clearing it.
    if (this.pending) return this.pending;
    const attempt = this.run().catch((error: unknown) => {
      this.pending = undefined;
      throw error;
    });
    this.pending = attempt;
    return attempt;
  }

  /**
   * Runs cleanup from a path with no caller to reject to (an unsolicited exit).
   * Owns the rejection so it never becomes an unhandled rejection; the failure is
   * swallowed because `attempt` cleared its cache, so a later explicit shutdown
   * retries cleanup and surfaces any persistent failure through its own error.
   */
  float(): void {
    void this.attempt().catch(() => undefined);
  }
}
