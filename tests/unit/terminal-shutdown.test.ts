/** Bounded render draining and cleanup failures (PRD §9.4, C-LIFE-12). */

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { drainAndDisposeTerminal } from "../../src/runtime/shutdown/terminal.ts";

/** A PTY that stays quiet for the whole drain; `unsubscribed` proves the listener is released. */
const unsubscribed = vi.fn();
const pty = { onData: () => unsubscribed };

beforeEach(() => {
  unsubscribed.mockClear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

test("C-LIFE-12 runtime cleanup drains received output before disposal", async () => {
  const rendered = Promise.withResolvers<void>();
  const dispose = vi.fn();
  const completion = drainAndDisposeTerminal({ settled: () => rendered.promise, dispose }, pty);
  expect(dispose).not.toHaveBeenCalled();
  rendered.resolve();
  await completion;
  expect(dispose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("C-LIFE-12 a stalled renderer is disposed after one second and late rejection is owned", async () => {
  const rendered = Promise.withResolvers<void>();
  const dispose = vi.fn();
  const completion = drainAndDisposeTerminal({ settled: () => rendered.promise, dispose }, pty);
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
])("C-LIFE-12 drain failure still disposes (synchronous: %s)", async (sync) => {
  const dispose = vi.fn();
  const error = new Error("render failed");
  const settled = () => {
    if (sync) throw error;
    return Promise.reject(error);
  };
  await expect(drainAndDisposeTerminal({ settled, dispose }, pty)).rejects.toBe(error);
  expect(dispose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("C-LIFE-12 disposal failures propagate after clearing the deadline", async () => {
  await expect(
    drainAndDisposeTerminal(
      {
        settled: () => Promise.resolve(),
        dispose: () => {
          throw new Error("dispose failed");
        },
      },
      pty,
    ),
  ).rejects.toThrow("dispose failed");
  expect(unsubscribed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
