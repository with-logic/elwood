/** One-shot loop timer seam coverage (PRD §5.9, C-LOOP-05/C-LOOP-13). */

import { afterEach, describe, expect, test, vi } from "vitest";
import { LoopTimerBank, scheduleLoopTimer } from "../../src/core/loops/timers.ts";

afterEach(() => vi.useRealTimers());

describe("loop timers", () => {
  test("production timers are unreferenced and cancellable", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const timer = scheduleLoopTimer(run, 10);
    timer.cancel();
    vi.advanceTimersByTime(10);
    expect(run).not.toHaveBeenCalled();
  });

  test("timer bank replaces keys, clamps delay, and clears every kind", () => {
    const delays: number[] = [];
    const cancelled: string[] = [];
    const callbacks: (() => void)[] = [];
    const bank = new LoopTimerBank((run, delay) => {
      const id = `timer-${callbacks.length}`;
      delays.push(delay);
      callbacks.push(run);
      return { cancel: () => cancelled.push(id) };
    });
    const run = vi.fn();
    bank.arm("due", "a", -1, run);
    bank.arm("due", "a", 2, run);
    expect(delays).toEqual([0, 2]);
    expect(cancelled).toEqual(["timer-0"]);
    callbacks[1]?.();
    expect(run).toHaveBeenCalledOnce();
    bank.arm("due", "b", 1, run);
    bank.arm("expiry", "b", 1, run);
    bank.cancelDue("b");
    bank.cancelLoop("b");
    bank.arm("expiry", "c", 1, run);
    bank.clear();
    expect(cancelled).toEqual(["timer-0", "timer-2", "timer-3", "timer-4"]);
  });
});
