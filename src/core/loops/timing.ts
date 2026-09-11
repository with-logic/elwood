/**
 * Due/expiry timing for recurring loops: arms each loop's next due time and wall-clock
 * expiry on the timer bank, retrying a failed arm once while live, and marks loops due
 * (batching any other loop already past its due time) when a timer fires.
 * Implements PRD §5.9 and C-LOOP-05/C-LOOP-08/C-LOOP-13.
 */

import { IDLE_LOOP_INTERVAL_MS } from "./constants.ts";
import type { LoopRuntimeEntry, LoopSchedulerState } from "./scheduler-state.ts";
import type { LoopTimerBank } from "./timers.ts";

type LoopTimingOptions = {
  readonly state: LoopSchedulerState;
  readonly now: () => number;
  readonly live: () => boolean;
  readonly fail: (entry: LoopRuntimeEntry) => void;
  readonly expire: (loopId: string) => void;
  readonly pump: () => void;
};

export class LoopTiming {
  private readonly options: LoopTimingOptions;
  private readonly timers: LoopTimerBank;

  constructor(timers: LoopTimerBank, options: LoopTimingOptions) {
    this.timers = timers;
    this.options = options;
  }

  armDue(entry: LoopRuntimeEntry, anchor: number, retry = true): void {
    const cadence =
      entry.definition.mode === "fixed" ? entry.definition.intervalMs : IDLE_LOOP_INTERVAL_MS;
    const dueAt = anchor + cadence + entry.definition.jitterMs;
    try {
      this.timers.arm("due", entry.definition.id, dueAt - this.options.now(), () =>
        this.markDue(entry.definition.id, dueAt),
      );
      entry.state = "scheduled";
      entry.nextDueAt = dueAt;
      entry.dueAt = undefined;
    } catch {
      entry.state = "waiting";
      this.options.fail(entry);
      if (retry) this.armDue(entry, this.options.now(), false); // one re-arm from a fresh anchor
    }
  }

  armExpiry(entry: LoopRuntimeEntry, retry = true): void {
    try {
      this.timers.arm(
        "expiry",
        entry.definition.id,
        entry.definition.expiresAt - this.options.now(),
        () => this.expireSafely(entry.definition.id),
      );
    } catch {
      this.options.fail(entry);
      if (retry) this.armExpiry(entry, false);
    }
  }

  expireSafely(loopId: string): void {
    try {
      this.options.expire(loopId);
    } catch {
      // Persistence failure was already converted into a contained loop event.
    }
  }

  private markDue(loopId: string, dueAt: number): void {
    const entry = this.options.state.get(loopId);
    if (!(entry && this.options.live())) return;
    entry.state = "due";
    entry.dueAt = dueAt;
    entry.nextDueAt = undefined;
    for (const scheduled of this.options.state.entries()) {
      if (scheduled.state !== "scheduled" || scheduled.nextDueAt === undefined) continue;
      if (scheduled.nextDueAt > dueAt) continue;
      scheduled.state = "due";
      scheduled.dueAt = scheduled.nextDueAt;
      scheduled.nextDueAt = undefined;
    }
    this.options.pump();
  }
}
