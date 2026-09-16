/** Bounded render draining and cleanup failures (PRD §9.4, C-PERF-05). */

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { drainAndDisposeTerminal } from "../../src/runtime/shutdown/terminal.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("C-PERF-05 runtime cleanup drains received output before disposal", async () => {
  const rendered = Promise.withResolvers<void>();
  const dispose = vi.fn();
  const completion = drainAndDisposeTerminal({ settled: () => rendered.promise, dispose });
  expect(dispose).not.toHaveBeenCalled();
  rendered.resolve();
  await completion;
  expect(dispose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("C-PERF-05 a stalled renderer is disposed after one second and late rejection is owned", async () => {
  const rendered = Promise.withResolvers<void>();
  const dispose = vi.fn();
  const completion = drainAndDisposeTerminal({ settled: () => rendered.promise, dispose });
  await vi.advanceTimersByTimeAsync(999);
  expect(dispose).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await completion;
  expect(dispose).toHaveBeenCalledOnce();
  rendered.reject(new Error("late renderer failure"));
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  false,
  true,
])("C-PERF-05 drain failure still disposes (synchronous: %s)", async (sync) => {
  const dispose = vi.fn();
  const error = new Error("render failed");
  const settled = () => {
    if (sync) throw error;
    return Promise.reject(error);
  };
  await expect(drainAndDisposeTerminal({ settled, dispose })).rejects.toBe(error);
  expect(dispose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("C-PERF-05 disposal failures propagate after clearing the deadline", async () => {
  await expect(
    drainAndDisposeTerminal({
      settled: () => Promise.resolve(),
      dispose: () => {
        throw new Error("dispose failed");
      },
    }),
  ).rejects.toThrow("dispose failed");
  expect(vi.getTimerCount()).toBe(0);
});
