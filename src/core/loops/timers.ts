/**
 * Injectable one-shot, unreferenced timers for recurring loops.
 * Implements PRD §5.9 and C-LOOP-05/C-LOOP-13.
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

import { IDLE_LOOP_INTERVAL_MS } from "./constants.ts";
import type { LoopRuntimeEntry, LoopSchedulerState } from "./scheduler-state.ts";

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
      if (retry && this.options.live()) this.armDue(entry, this.options.now(), false);
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
      if (retry && this.options.live()) this.armExpiry(entry, false);
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
