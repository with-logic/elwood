/** Native answer deadlines survive Node's timer-delay boundary (PRD §4). */
import { afterEach, expect, test, vi } from "vitest";
import { questionDeadline } from "../../../src/core/questions/deadline.ts";
import { MAX_TIMER_DELAY_MS } from "../../../src/core/timers.ts";

afterEach(() => vi.useRealTimers());

test("a long question deadline rearms after the capped interval and expires only at its deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const expire = vi.fn();
  const cancel = questionDeadline(MAX_TIMER_DELAY_MS + 10, expire);
  await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
  expect(expire).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(9);
  expect(expire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(expire).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  cancel();
});

test("cancelling a rearmed question deadline clears the remaining interval", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const expire = vi.fn();
  const cancel = questionDeadline(MAX_TIMER_DELAY_MS + 10, expire);
  await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
  cancel();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10);
  expect(expire).not.toHaveBeenCalled();
});
