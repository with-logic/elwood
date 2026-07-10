/**
 * Serializes a session's overlapping stop/kill/teardown so the PTY is signaled at
 * most once (PRD §5.3/§9.4, C-LIFE-10). Concurrent shutdown calls can each snapshot
 * a non-terminal status and race into `terminatePty`; if the OS process exits before
 * node-pty's exit callback updates status, a later caller could signal the numeric
 * PID again AFTER the kernel recycled it, and duplicate waiters / first-wins evidence
 * could mislabel a force-killed exit as merely stopped. The coordinator is claimed
 * SYNCHRONOUSLY before any signal: the first caller owns the in-flight shutdown and
 * every later caller JOINS the same promise rather than re-signaling. An escalating
 * request (a `kill()` arriving during an in-flight `stop()`, or a `teardown()`) chains
 * AFTER the in-flight run — by then the session is terminal, so the escalation performs
 * only the one-shot survivor reap and its own extra work (never a second PTY signal).
 */

/** Ordered so a later request can tell whether it escalates the in-flight one. */
export type ShutdownLevel = "stop" | "kill" | "teardown";

const levelRank: Readonly<Record<ShutdownLevel, number>> = { stop: 0, kill: 1, teardown: 2 };

type InFlight = { readonly level: ShutdownLevel; readonly promise: Promise<void> };

/**
 * One coordinator per session. `run` is claimed synchronously: it records the
 * in-flight request before returning control, so a concurrent caller entering the
 * same tick sees it and joins instead of starting a second, racing shutdown.
 */
export class ShutdownCoordinator {
  private inFlight: InFlight | undefined;

  /**
   * Claim (or join) the in-flight shutdown for `level`, running `operation` only
   * when this call actually owns work:
   *   - No in-flight run: this caller owns it; `operation` runs immediately.
   *   - In-flight run of an equal-or-higher level: JOIN it (await the same promise);
   *     `operation` never runs, so the PTY is not signaled a second time.
   *   - In-flight run of a LOWER level (escalation): chain `operation` AFTER the
   *     in-flight run settles. The session is terminal by then, so `operation`
   *     takes its already-terminal path (one-shot reap, no re-signal).
   * The claim is synchronous: `inFlight` is assigned before the returned promise
   * yields, so overlapping callers in the same tick observe it.
   */
  run(level: ShutdownLevel, operation: () => Promise<void>): Promise<void> {
    const current = this.inFlight;
    if (current && levelRank[current.level] >= levelRank[level]) return current.promise;
    // No in-flight run: this caller owns it and starts SYNCHRONOUSLY (no microtask gap
    // before the PTY signal). An escalation chains AFTER the lower-level in-flight run
    // so it observes the terminal status that run produced; the predecessor's rejection
    // is absorbed here (each shutdown still surfaces its own failure to its own caller).
    const promise = current ? current.promise.then(operation, operation) : operation();
    this.inFlight = { level, promise };
    return promise;
  }
}
