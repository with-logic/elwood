/** Mutex cancellation preserves ownership through task cleanup (PRD §5.3, C-API-46). */
import { getEventListeners } from "node:events";
import { expect, test, vi } from "vitest";
import { createAsyncMutex } from "../../src/core/async-mutex.ts";

test("C-API-46 cancelling the holder waits for its cleanup and preserves its result", async () => {
  const lock = createAsyncMutex();
  const cleanup = Promise.withResolvers<string>();
  const abort = new AbortController();
  const entered = vi.fn(() => cleanup.promise);
  let settled = false;
  const first = lock(entered, { signal: abort.signal, error: () => new Error("cancelled") });
  void first.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(entered).toHaveBeenCalledOnce();
  abort.abort();
  const next = vi.fn(async () => "next");
  const second = lock(next);
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(next).not.toHaveBeenCalled();
  cleanup.resolve("restored");
  await expect(first).resolves.toBe("restored");
  await expect(second).resolves.toBe("next");
});

test("C-API-46 cancelling a waiter settles immediately and never runs its task", async () => {
  const lock = createAsyncMutex();
  const cleanup = Promise.withResolvers<void>();
  const first = lock(() => cleanup.promise);
  const abort = new AbortController();
  const task = vi.fn(async () => undefined);
  const second = lock(task, { signal: abort.signal, error: () => new Error("cancelled") });
  const rejected = expect(second).rejects.toThrow("cancelled");
  abort.abort();
  await rejected;
  expect(task).not.toHaveBeenCalled();
  cleanup.resolve();
  await first;
  await lock(async () => undefined);
  expect(task).not.toHaveBeenCalled();
});

test("already cancelled waiters do not enter and task failures preserve the queue", async () => {
  const lock = createAsyncMutex();
  const abort = new AbortController();
  abort.abort();
  const task = vi.fn(async () => undefined);
  await expect(
    lock(task, { signal: abort.signal, error: () => new Error("cancelled") }),
  ).rejects.toThrow("cancelled");
  expect(task).not.toHaveBeenCalled();
  await expect(
    lock(
      () => {
        throw new Error("task failed");
      },
      {
        signal: new AbortController().signal,
        error: () => new Error("unused"),
      },
    ),
  ).rejects.toThrow("task failed");
  await expect(lock(async () => "next")).resolves.toBe("next");
});

test("an already-aborted waiter leaves no listener behind an active holder", async () => {
  const lock = createAsyncMutex();
  const held = Promise.withResolvers<void>();
  const holder = lock(() => held.promise);
  const abort = new AbortController();
  abort.abort();
  try {
    await expect(
      lock(async () => undefined, {
        signal: abort.signal,
        error: () => new Error("cancelled"),
      }),
    ).rejects.toThrow("cancelled");
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  } finally {
    held.resolve();
    await holder;
  }
});

test("cancelled waiters detach immediately while the holder stays pending", async () => {
  const lock = createAsyncMutex();
  const held = Promise.withResolvers<void>();
  const holder = lock(() => held.promise);
  await Promise.resolve();
  const order: string[] = [];
  const before = lock(() => Promise.resolve(order.push("before")));
  const cancelled = Array.from({ length: 32 }, () => {
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const error = vi.fn(() => new Error("cancelled"));
    const task = vi.fn(async () => undefined);
    const result = lock(task, { signal: abort.signal, error });
    const rejected = expect(result).rejects.toThrow("cancelled");
    abort.abort();
    return { abort, remove, error, task, rejected };
  });
  const after = lock(() => Promise.resolve(order.push("after")));
  try {
    await Promise.all(cancelled.map(({ rejected }) => rejected));
    for (const { abort, remove, error, task } of cancelled) {
      expect(remove).toHaveBeenCalledOnce();
      expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
      expect(error).toHaveBeenCalledOnce();
      expect(task).not.toHaveBeenCalled();
    }
    expect(order).toEqual([]);
  } finally {
    held.resolve();
    await Promise.all([holder, before, after]);
  }
  expect(order).toEqual(["before", "after"]);
  // Draining the queue must never revisit cancelled waiters or their captured state.
  for (const { remove, error, task } of cancelled) {
    expect(task).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  }
});

test("cancellation before acquisition leaves the mutex reusable", async () => {
  const lock = createAsyncMutex();
  const abort = new AbortController();
  const task = vi.fn(async () => undefined);
  const first = lock(task, { signal: abort.signal, error: () => new Error("cancelled") });
  const rejected = expect(first).rejects.toThrow("cancelled");
  abort.abort();
  await rejected;
  expect(task).not.toHaveBeenCalled();
  await expect(lock(async () => "reused")).resolves.toBe("reused");
});
