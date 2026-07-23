/**
 * Coalesces runtime-cleanup attempts while keeping a FAILED cleanup retryable.
 * PRD §9.4 requires that a settled cleanup failure is not permanently sticky — a
 * later explicit stop/kill/teardown must run a fresh attempt. A plain `??=` cache
 * would latch a rejected promise forever, so this latch clears its cache the moment
 * the attempt rejects. `cachedAttempt` is therefore only ever the reusable non-rejected
 * attempt (in flight or successfully settled). Implements PRD §9.4.
 */

export class CleanupLatch {
  private cachedAttempt: Promise<void> | undefined;
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
    // A cached attempt is reused only when it is in flight or already settled
    // SUCCESSFULLY; a rejecting attempt clears the cache below before any other
    // caller can observe it, so no identity guard is needed on the clear.
    if (this.cachedAttempt) return this.cachedAttempt;
    const attempt = this.run().catch((error: unknown) => {
      this.cachedAttempt = undefined;
      throw error;
    });
    this.cachedAttempt = attempt;
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
