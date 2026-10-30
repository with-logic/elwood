/** Idle signal passes start immediately; busy and failed passes keep serialization (C-LIFE-13). */
import { expect, test, vi } from "vitest";
import { SerialReapQueue } from "../../src/runtime/shutdown/reap-queue.ts";

test("C-LIFE-13 an idle pass starts in this tick and a later idle pass does too", async () => {
  const queue = new SerialReapQueue();
  const first = vi.fn(() => Promise.resolve(1));
  const pending = queue.run(first);
  expect(first).toHaveBeenCalledOnce();
  expect(await pending).toBe(1);
  const next = vi.fn(() => Promise.resolve(2));
  const nextPending = queue.run(next);
  expect(next).toHaveBeenCalledOnce();
  expect(await nextPending).toBe(2);
});

test("C-LIFE-14 a queued pass waits for the earlier pass, even if it rejected", async () => {
  const queue = new SerialReapQueue();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const order: string[] = [];
  const pendingFirst = queue.run(() => first.promise);
  const failed = expect(pendingFirst).rejects.toThrow("failed");
  const pendingSecond = queue.run(() => {
    order.push("second");
    return second.promise;
  });
  expect(order).toEqual([]);
  first.reject(new Error("failed"));
  await failed;
  const pendingThird = queue.run(() => {
    order.push("third");
    return Promise.resolve();
  });
  expect(order).toEqual(["second"]);
  second.resolve();
  await Promise.all([pendingSecond, pendingThird]);
  expect(order).toEqual(["second", "third"]);
});

test("C-LIFE-14 a synchronously throwing pass releases its queue", async () => {
  const queue = new SerialReapQueue();
  await expect(
    queue.run(() => {
      throw new Error("thrown");
    }),
  ).rejects.toThrow("thrown");
  const next = vi.fn(() => Promise.resolve());
  const pending = queue.run(next);
  expect(next).toHaveBeenCalledOnce();
  await pending;
});
