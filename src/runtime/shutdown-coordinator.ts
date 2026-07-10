/**
 * Serializes a session's overlapping stop/kill/teardown so the PTY is signaled at
 * most once (PRD §5.3/§9.4, C-LIFE-10). Concurrent shutdown calls can each snapshot
 * a non-terminal status and race into `terminatePty`; if the OS process exits before
 * node-pty's exit callback updates status, a later caller could signal the numeric
 * PID again AFTER the kernel recycled it, and duplicate waiters / first-wins evidence
 * could mislabel a force-killed exit as merely stopped.
 *
 * Two pieces of state, tracked SEPARATELY, make this safe and still retryable:
 *   - `signaled` — sticky, set the first time any shutdown signals the PTY. It is
 *     NEVER cleared. A later caller that finds it set does NOT re-signal solely
 *     because the lifecycle status is still non-terminal (a predecessor that
 *     signaled+reaped but threw before submitting terminal status must not cause a
 *     re-signal of a possibly-recycled PID); it may still reap/cleanup/teardown.
 *   - `inFlight` — the current in-flight run, CLEARED on settlement (with identity
 *     protection). A failed `stop()`/`kill()`/`teardown()` therefore does not return
 *     a permanently rejected promise to every later caller: once it settles, a later
 *     call starts a fresh operation that RETRIES reap/cleanup/removal without
 *     re-signaling the PTY (C-LIFE-10 retry posture).
 */

/** Ordered so a later request can tell whether it escalates the in-flight one. */
export type ShutdownLevel = "stop" | "kill" | "teardown";

const levelRank: Readonly<Record<ShutdownLevel, number>> = { stop: 0, kill: 1, teardown: 2 };

/** What a coordinated shutdown operation is told about prior signal ownership. */
export type ShutdownContext = {
  /** True once ANY prior shutdown signaled the PTY — do not re-signal, only reap/cleanup. */
  readonly alreadySignaled: boolean;
  /** Record that this operation is about to signal the PTY (idempotent). */
  readonly markSignaled: () => void;
};

type ShutdownOperation = (context: ShutdownContext) => Promise<void>;
type InFlight = { readonly level: ShutdownLevel; readonly promise: Promise<void> };

/**
 * One coordinator per session. `run` is claimed synchronously: it records the
 * in-flight request before returning control, so a concurrent caller entering the
 * same tick sees it and joins instead of starting a second, racing shutdown.
 */
export class ShutdownCoordinator {
  private inFlight: InFlight | undefined;
  // Sticky: once the PTY is signaled it must never be signaled again (recycled PID),
  // independently of whether a run reached a terminal status before it settled.
  private signaled = false;

  /**
   * Claim (or join) the in-flight shutdown for `level`, running `operation` only
   * when this call actually owns work:
   *   - No in-flight run: this caller owns it; `operation` runs immediately.
   *   - In-flight run of an equal-or-higher level: JOIN it (await the same promise);
   *     `operation` never runs, so the PTY is not signaled a second time.
   *   - In-flight run of a LOWER level (escalation): chain `operation` AFTER the
   *     in-flight run settles, so it observes the terminal status that run produced.
   * The operation is told whether the PTY was `alreadySignaled` so it reaps/cleans
   * up instead of re-signaling. On settlement `inFlight` is cleared (identity-guarded)
   * so a later call can retry a failed reap/cleanup without re-signaling.
   */
  run(level: ShutdownLevel, operation: ShutdownOperation): Promise<void> {
    const current = this.inFlight;
    if (current && levelRank[current.level] >= levelRank[level]) return current.promise;
    const invoke = () => operation(this.context());
    // No in-flight run: this caller owns it and starts SYNCHRONOUSLY (no microtask gap
    // before the PTY signal). An escalation chains AFTER the lower-level in-flight run
    // so it observes the terminal status that run produced; the predecessor's rejection
    // is absorbed here (each shutdown still surfaces its own failure to its own caller).
    const promise = current ? current.promise.then(invoke, invoke) : invoke();
    const entry: InFlight = { level, promise };
    this.inFlight = entry;
    // Clear on settlement so a settled failure never permanently blocks a retry — but
    // only if this is still the active entry (a newer run must not be clobbered). The
    // rejection is swallowed on THIS observer only; the `promise` returned to the
    // caller still rejects so each shutdown surfaces its own failure.
    promise.then(
      () => this.clear(entry),
      () => this.clear(entry),
    );
    return promise;
  }

  /** Drop the active entry once it settles, but never clobber a newer one. */
  private clear(entry: InFlight): void {
    if (this.inFlight === entry) this.inFlight = undefined;
  }

  private context(): ShutdownContext {
    return {
      alreadySignaled: this.signaled,
      markSignaled: () => {
        this.signaled = true;
      },
    };
  }
}
