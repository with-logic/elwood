/**
 * Claude guidance queued behind a running turn, tracked only from what Elwood owns or already
 * receives: the guidance it writes while the session runs, the caller handler's answer to each
 * queued `UserPromptSubmit`, and the prompt ID on Claude's hooks, never the transcript (PRD §6.5,
 * C-HOOK-24). A tool boundary delivers allowed guidance inside the running turn. Guidance still
 * queued at a `Stop` runs at once as a new turn under a new prompt ID, so that `Stop` is held
 * until the new turn's own `Stop`.
 */
import { type DeadlineClock, deadlineClock } from "../../core/timers.ts";

/** How long guidance Elwood wrote may go unheard: its hook fires ~130 ms after the Enter. */
export const unheardGuidanceLimitMs = 2_000;
/** The longest a `Stop` is held with neither the queued turn's `Stop` nor an idle composer. */
export const queuedTurnHangLimitMs = 120_000;

/** The caller handler's answer to one queued `UserPromptSubmit`. */
export type GuidanceAnswer = (blocked: boolean) => void;

export class ClaudeGuidanceLedger {
  private runningTurn: string | undefined;
  private heldTurn: string | undefined;
  private screening = 0;
  /** Allowed guidance not yet delivered by a tool boundary or a queued turn. */
  private queued = 0;
  /** Allowed guidance the held `Stop`'s queued turn starts with; later allows wait behind it. */
  private startsQueuedTurn = 0;
  /** When each guidance write still waiting for its hook happened, oldest first. */
  private readonly unheard: number[] = [];
  private hangTimer: unknown;
  private unheardTimer: unknown;
  private readonly release: (hung: boolean) => void;
  private readonly clock: DeadlineClock;

  constructor(release: (hung: boolean) => void, clock: DeadlineClock = deadlineClock) {
    this.release = release;
    this.clock = clock;
  }

  /** Elwood wrote guidance while the session was running. */
  written(): void {
    this.unheard.push(this.clock.now());
  }

  /** A `UserPromptSubmit` arrived. Returns how to record the answer when it queues guidance. */
  heard(promptId: string | undefined): GuidanceAnswer | undefined {
    this.unheard.shift();
    if (promptId === undefined) return undefined;
    // Outside a hold, a new ID is a turn's own prompt. An interrupt re-fires a queued message
    // this way as it runs it, so that message is no longer queued.
    if (this.heldTurn === undefined && promptId !== this.runningTurn) {
      this.runningTurn = promptId;
      this.queued = 0;
      return undefined;
    }
    this.screening += 1;
    return (blocked) => {
      this.screening -= 1;
      if (blocked) return this.settle();
      // A held `Stop` with nothing queued yet starts its queued turn with the first allow.
      if (this.heldTurn !== undefined && this.startsQueuedTurn === 0) this.startsQueuedTurn = 1;
      else this.queued += 1;
    };
  }

  /** A tool finished: Claude delivers allowed guidance before its next model request. */
  toolBoundary(): void {
    this.queued = 0;
  }

  /** Whether this unblocked `Stop` must wait for the queued turn it leaves behind. */
  stopHolds(promptId: string | undefined): boolean {
    if (this.heldTurn !== undefined && promptId === this.heldTurn) return true;
    this.clearTimers();
    this.startsQueuedTurn = 0;
    this.pruneUnheard();
    const pending = this.queued > 0 || this.screening > 0 || this.unheard.length > 0;
    this.heldTurn = pending ? promptId : undefined;
    if (this.heldTurn === undefined) return false;
    this.startsQueuedTurn = this.queued;
    this.queued = 0;
    this.hangTimer = this.clock.setTimer(() => this.end(true), queuedTurnHangLimitMs);
    this.expireUnheard();
    return true;
  }

  /** Whether Claude's idle composer may end the turn now: never while guidance is undecided. */
  renderedEndReleases(): boolean {
    if (this.heldTurn === undefined) return true;
    this.pruneUnheard();
    if (this.screening > 0 || this.unheard.length > 0) return false;
    this.reset();
    return true;
  }

  /** Stop every timer when the session closes. */
  dispose(): void {
    this.reset();
  }

  private settle(): void {
    this.pruneUnheard();
    const undecided = this.screening > 0 || this.unheard.length > 0;
    if (this.heldTurn !== undefined && this.startsQueuedTurn === 0 && !undecided) this.end(false);
    else this.expireUnheard();
  }

  /** While a `Stop` is held, settle again when the oldest unheard write passes its limit. */
  private expireUnheard(): void {
    const oldest = this.unheard[0];
    this.clock.clearTimer(this.unheardTimer);
    if (this.heldTurn === undefined || oldest === undefined) return;
    const delayMs = oldest + unheardGuidanceLimitMs - this.clock.now();
    this.unheardTimer = this.clock.setTimer(() => this.settle(), delayMs);
  }

  private end(hung: boolean): void {
    this.reset();
    this.release(hung);
  }

  private reset(): void {
    this.clearTimers();
    this.heldTurn = undefined;
    this.startsQueuedTurn = 0;
    this.queued = 0;
  }

  private pruneUnheard(): void {
    const now = this.clock.now();
    while (this.unheard[0] !== undefined && now - this.unheard[0] >= unheardGuidanceLimitMs)
      this.unheard.shift();
  }

  private clearTimers(): void {
    this.clock.clearTimer(this.hangTimer);
    this.clock.clearTimer(this.unheardTimer);
  }
}
