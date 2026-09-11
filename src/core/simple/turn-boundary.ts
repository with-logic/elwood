/**
 * The turn's REAL agent boundary (PRD §5.8, C-API-48/50): the point past which the serializer
 * may start the next turn. Separated from the runner (turn.ts) to keep both under the size cap.
 *
 * SUCCESS path: the gate's genuine end (oracle matched / quiet window — the transcript has
 * drained) or a terminal status. NOT bare `ready`: Claude transcript activity arrives AFTER
 * `ready`, so releasing there would let the next turn bind this turn's still-arriving (untagged)
 * activity. FAILURE path (consumer timeout/catch-up/backlog): the agent may still be RUNNING —
 * and a silent long-running tool is quiet, not done — so a quiet window is unsafe. The boundary
 * then waits for a real `ready` (a busy agent is `running`, not ready) or terminal, followed by
 * a short transcript-drain settle. A hung agent holds the slot until `close()`/`kill()` forces a
 * terminal status — honest backpressure, never a silent early release.
 */

/** Short transcript-drain settle (ms) after a post-failure `ready` — trailing events flush. */
const DRAIN_MS = 750;

export class TurnBoundary {
  /** Resolves when the next turn may safely start. The serializer holds its slot on this. */
  readonly promise: Promise<void>;
  private resolve!: () => void;
  private reached = false;
  private consumerFailed = false;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onReach: () => void;
  private readonly drainMs: number;

  /** `onReach` runs once the boundary lands (e.g. to attempt listener cleanup). `drainMs` is the
   *  post-failure `ready` drain window (default `DRAIN_MS`; overridable for tests). */
  constructor(onReach: () => void, drainMs = DRAIN_MS) {
    this.onReach = onReach;
    this.drainMs = drainMs;
    this.promise = new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }

  /** Land the boundary now (idempotent): a terminal status, or the gate's genuine success end. */
  reach(): void {
    if (this.reached) return;
    this.reached = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = undefined; // so `draining` reports the truth once the boundary has landed
    this.resolve();
    this.onReach();
  }

  /** Mark that the consumer turn failed: the boundary now waits for a real `ready`/terminal, not quiet. */
  markConsumerFailed(): void {
    this.consumerFailed = true;
  }

  /**
   * A `ready` after a consumer failure means the agent turn is done (a still-working tool is
   * `running`, not ready): arm a short transcript-drain settle so trailing untagged events flush
   * before the slot releases. Re-armed by further activity/`ready`. No-op before a failure or once
   * the boundary is reached.
   */
  armDrain(): void {
    if (this.reached || !this.consumerFailed) return;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => this.reach(), this.drainMs);
    this.drainTimer.unref?.();
  }

  /** True once a drain settle is pending — a trailing event should re-arm it, not ignore it. */
  get draining(): boolean {
    return this.drainTimer !== undefined;
  }

  /** True once the boundary has landed (for the runner's combined cleanup gate). */
  get isReached(): boolean {
    return this.reached;
  }
}
