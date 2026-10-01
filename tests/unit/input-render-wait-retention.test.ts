/** Render budget retries retain one reaction per unfinished render (PRD §5.3, C-API-56). */
import { afterEach, expect, test, vi } from "vitest";
import { writeUnsafe } from "../../src/core/input/abort.ts";

afterEach(() => vi.useRealTimers());

test("C-API-56 repeated observation timeouts do not stack render promise reactions", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const reactions = vi.spyOn(pending, "then");
  const terminal = { sendInput: () => undefined, settled: () => pending };
  try {
    for (let i = 0; i < 20; i += 1) {
      const observation = writeUnsafe(terminal);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await observation).toBe(true);
    }
    expect(reactions).toHaveBeenCalledTimes(1);
  } finally {
    finish();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(await writeUnsafe(terminal)).toBe(false);
});

test("C-API-56 cancelled and timed-out observers detach while a live waiter completes", async () => {
  vi.useFakeTimers();
  const render = Promise.withResolvers<void>();
  const reactions = vi.spyOn(render.promise, "then");
  const cancel = new AbortController();
  const terminal = { sendInput: () => undefined, settled: () => render.promise };
  const cancelled = writeUnsafe(terminal, undefined, cancel.signal, true);
  const live = writeUnsafe(terminal, undefined, undefined, true);
  const timed = writeUnsafe(terminal);
  cancel.abort();
  expect(await cancelled).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await timed).toBe(true);
  expect(reactions).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  render.resolve();
  expect(await live).toBe(false);
});

test("C-API-56 synchronous render observers can cancel before settlement waiting starts", async () => {
  const cancel = new AbortController();
  const pending = Promise.withResolvers<void>();
  const terminal = {
    sendInput: () => undefined,
    settled() {
      cancel.abort();
      return pending.promise;
    },
  };
  try {
    expect(await writeUnsafe(terminal, undefined, cancel.signal, true)).toBe(true);
  } finally {
    pending.resolve();
  }
});
