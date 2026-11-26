/**
 * Claude guidance queued behind a running turn, tracked only from what Elwood owns or already
 * receives: the guidance it writes into a turn, the caller handler's answer to each queued
 * `UserPromptSubmit`, and the prompt ID on that hook, never the transcript (PRD §6.5,
 * C-HOOK-24). A tool boundary delivers allowed guidance inside the running turn. Guidance still
 * queued at a `Stop` runs at once as a new turn, so that `Stop` is held until the next one.
 */
import { type DeadlineClock, deadlineClock } from "../../../core/timers.ts";

/** How long input Elwood wrote may go unheard: its hook fires ~130 ms after the Enter. */
export const unheardGuidanceLimitMs = 2_000;
/** The longest a `Stop` is held with neither the queued turn's `Stop` nor an idle composer. */
export const queuedTurnHangLimitMs = 120_000;

/** What a hold waits on: allowed guidance still queued, a handler still screening, or a write. */
export type GuidanceHold = "queued" | "screening" | "unheard";
/** What ended a hold when neither the next `Stop` nor Claude's idle composer did. */
export type GuidanceRelease = "blocked" | "unheard" | "hung";
/** The caller handler's answer to one queued `UserPromptSubmit`. Call it exactly once. */
export type GuidanceAnswer = (blocked: boolean) => void;

export class ClaudeGuidanceLedger {
  private runningTurn: string | undefined;
  private held = false;
  private disposed = false;
  private screening = 0;
  /** Allowed guidance that neither a tool boundary nor a queued turn has delivered yet. */
  private undelivered = false;
  /** Allowed guidance starts the held `Stop`'s queued turn; later allows wait behind it. */
  private queuedTurnAllowed = false;
  /** When each guidance write still waiting for its hook happened, oldest first. */
  private readonly unheard: number[] = [];
  private hangTimer: unknown;
  private unheardTimer: unknown;
  private readonly release: (cause: GuidanceRelease) => void;
  private readonly clock: DeadlineClock;

  constructor(release: (cause: GuidanceRelease) => void, clock: DeadlineClock = deadlineClock) {
    this.release = release;
    this.clock = clock;
  }

  /** Elwood submitted input inside a Claude turn: the prompt that started it, or guidance. */
  written(): void {
    this.unheard.push(this.clock.now());
  }

  /** Records a `UserPromptSubmit`; returns the answer callback when it carries guidance. */
  heard(promptId: string | undefined): GuidanceAnswer | undefined {
    this.unheard.shift();
    if (promptId === undefined) return undefined;
    // Outside a hold, a new ID is a turn's own prompt. An interrupt re-fires a queued message
    // this way as it runs it, so that message is no longer queued.
    if (!this.held && promptId !== this.runningTurn) {
      this.runningTurn = promptId;
      this.undelivered = false;
      return undefined;
    }
    this.screening += 1;
    return (blocked) => {
      this.screening -= 1;
      if (blocked) return this.settle("blocked");
      if (this.held && !this.queuedTurnAllowed) this.queuedTurnAllowed = true;
      else this.undelivered = true;
    };
  }

  /** A tool finished: Claude delivers allowed guidance before its next model request. */
  toolBoundary(): void {
    this.undelivered = false;
  }

  /**
   * Records an unblocked `Stop`, and holds it while guidance is queued behind its turn. A `Stop`
   * without a prompt ID, from a CLI that does not name its turns, is never held.
   */
  holdStop(promptId: string | undefined): GuidanceHold | undefined {
    this.clearTimers();
    this.pruneUnheard();
    const hold = this.disposed || promptId === undefined ? undefined : this.waitingOn();
    this.held = hold !== undefined;
    this.queuedTurnAllowed = this.undelivered;
    this.undelivered = false;
    if (hold === undefined) return undefined;
    this.hangTimer = this.clock.setTimer(() => this.end("hung"), queuedTurnHangLimitMs);
    this.expireUnheard();
    return hold;
  }

  /** Claude's idle composer ends a hold unless guidance is undecided; returns what it waits on. */
  holdRenderedEnd(): GuidanceHold | undefined {
    if (!this.held) return undefined;
    this.pruneUnheard();
    const undecided = this.undecided();
    if (undecided === undefined) this.reset();
    return undecided;
  }

  /** Stop every timer when the session closes; a later `Stop` holds nothing. */
  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private waitingOn(): GuidanceHold | undefined {
    return this.undelivered ? "queued" : this.undecided();
  }

  private undecided(): GuidanceHold | undefined {
    if (this.screening > 0) return "screening";
    return this.unheard.length > 0 ? "unheard" : undefined;
  }

  private settle(cause: "blocked" | "unheard"): void {
    this.pruneUnheard();
    if (this.held && !this.queuedTurnAllowed && this.undecided() === undefined) this.end(cause);
    else this.expireUnheard();
  }

  /** While a `Stop` is held, settle again when the oldest unheard write passes its limit. */
  private expireUnheard(): void {
    const oldest = this.unheard[0];
    this.clock.clearTimer(this.unheardTimer);
    if (!this.held || oldest === undefined) return;
    const delayMs = oldest + unheardGuidanceLimitMs - this.clock.now();
    this.unheardTimer = this.clock.setTimer(() => this.settle("unheard"), delayMs);
  }

  private end(cause: GuidanceRelease): void {
    this.reset();
    this.release(cause);
  }

  private reset(): void {
    this.clearTimers();
    this.held = false;
    this.queuedTurnAllowed = false;
    this.undelivered = false;
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
